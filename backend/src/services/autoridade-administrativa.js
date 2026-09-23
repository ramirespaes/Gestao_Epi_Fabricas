'use strict';

const { HttpError } = require('../errors/HttpError');
const usuarioRepo = require('../repositories/usuario.repository');
const permissaoRepo = require('../repositories/permissao.repository');
const autorizacaoRepo = require('../repositories/autorizacao-individual.repository');

/**
 * Autoridade administrativa sobre a configuração de acesso (RBAC — Bloco 8,
 * Incremento 8, Etapa 5A).
 *
 * PONTO ÚNICO DE DECISÃO, deliberadamente. Nasceu dentro de
 * grupo-acesso.service.js na Subetapa 3J e foi extraído aqui na 3K, quando
 * um segundo serviço administrativo (grupo-permissao.service.js) passou a
 * precisar exatamente da mesma regra: duplicá-la significaria que a futura
 * entrada de ADMINISTRADORES expressamente autorizados pelo MASTER teria de
 * ser implementada em dois lugares — e um deles seria esquecido. Extrair
 * preservou a propriedade que a 3J estabeleceu de propósito, e é o que
 * permitiu que a Subetapa 3Q acrescentasse esse caminho em UM arquivo só,
 * sem tocar nenhuma das operações administrativas que o consomem.
 *
 * DOIS CAMINHOS DE AUTORIDADE, NESTA ORDEM:
 *
 *   1. MASTER ativo da própria empresa — autoridade plena sobre as três
 *      operações administrativas, por perfil, exatamente como desde a 3J.
 *      Não precisa de autorização individual nenhuma e não é afetado pela
 *      migration 024; a dispensa do MASTER é decisão desta camada, nunca
 *      do catálogo (mesma disciplina do middleware desde a 3D).
 *
 *   2. ADMINISTRADOR ativo da própria empresa QUE TENHA autorização
 *      individual efetiva para a ação administrativa correspondente
 *      àquela operação (Subetapa 3Q). "Expressamente autorizado" é
 *      literal: exige uma linha PRÓPRIA em usuario_autorizacoes,
 *      nominal, concedida pelo MASTER — as três ações nascem em modo
 *      OBRIGATORIA (migration 024) justamente para que permissoes_acao
 *      (permissão por PERFIL) jamais baste sozinha. Ter o perfil
 *      ADMINISTRADOR, por si só, não concede absolutamente nada.
 *
 * Qualquer outro caso — SUPERVISOR, USUARIO, ator inexistente, inativo,
 * de outra empresa, ou ADMINISTRADOR sem a autorização daquela operação
 * específica — recebe exatamente o mesmo erro, sem revelar qual das
 * condições falhou: mesma disciplina de PERMISSAO_NEGADA no middleware.
 *
 * GRANULARIDADE POR OPERAÇÃO: cada serviço administrativo declara, na
 * própria chamada, QUAL ação administrativa está em jogo
 * (ACOES_ADMINISTRATIVAS abaixo). Um ADMINISTRADOR autorizado a
 * configurar permissões de grupo não ganha, com isso, o direito de criar
 * grupos ou de mover pessoas entre eles — são três concessões
 * independentes. O código da ação nunca vem da requisição HTTP: é fixo
 * no serviço que executa a operação.
 *
 * "AUTORIZAÇÃO EFETIVA" É RECALCULADA COM AS MESMAS LEITURAS DE SEMPRE:
 * permissao.repository.js — o mesmo módulo que o middleware usa para
 * decidir autorização e que autorizacao-individual.service.js (3I) usa
 * para avaliar o delegador. Nenhum SQL novo, nenhuma segunda fonte de
 * verdade, nenhuma reinterpretação de TRUE/FALSE/NULL. Ver
 * administradorTemAutoridadeEfetiva().
 *
 * O QUE ESTE MÓDULO CONTINUA NÃO FAZENDO: não concede, não revoga e não
 * delega autoridade nenhuma — só a verifica. Conceder é ato do MASTER
 * pelo serviço de autorizações individuais (3I/3P), com toda a cadeia de
 * origem, pode_delegar, auditoria transacional e proibição de
 * autoconcessão que já existem lá, sem nenhuma regra nova criada aqui.
 * Revogar autoridade administrativa é, pela mesma razão, apenas revogar
 * aquela autorização individual: no instante seguinte este módulo deixa
 * de encontrá-la e o ADMINISTRADOR volta a ser recusado.
 */

const PERFIL_MASTER = 'MASTER';
const PERFIL_ADMINISTRADOR = 'ADMINISTRADOR';

/**
 * Códigos do catálogo real (`acoes`, migration 024) que representam cada
 * operação administrativa. Exportados como constantes para que nenhum
 * serviço precise repetir a string — e para que um código inexistente
 * falhe alto, aqui, em vez de silenciosamente nunca autorizar ninguém.
 */
const ACOES_ADMINISTRATIVAS = Object.freeze({
  GRUPOS_ACESSO: 'ADMINISTRAR_GRUPOS_ACESSO',
  PERMISSOES_GRUPO: 'ADMINISTRAR_PERMISSOES_GRUPO',
  VINCULOS_GRUPO: 'ADMINISTRAR_VINCULOS_GRUPO',
});

const ACOES_ADMINISTRATIVAS_VALIDAS = new Set(Object.values(ACOES_ADMINISTRATIVAS));

// Mesmos três valores do CHECK da migration 017, revalidados aqui pela
// mesma razão do middleware e da 3I: uma configuração de ação que o
// backend não reconhece nunca recebe um valor padrão implícito.
const MODO_NENHUMA = 'NENHUMA';
const MODOS_AUTORIZACAO_INDIVIDUAL_VALIDOS = new Set([MODO_NENHUMA, 'ALTERNATIVA', 'OBRIGATORIA']);

/**
 * A operação administrativa é sempre escolhida pelo serviço que executa,
 * nunca pelo cliente. Um valor fora do conjunto é erro de programação —
 * TypeError, não 403, para não ser confundido com "sem autoridade".
 */
function exigirAcaoAdministrativa(acaoAdministrativa) {
  if (!ACOES_ADMINISTRATIVAS_VALIDAS.has(acaoAdministrativa)) {
    throw new TypeError('ação administrativa inválida');
  }
}

/** Caminho 1: MASTER ativo da própria empresa. Perfil sempre relido do banco. */
const temAutoridadeDeMaster = (ator) => ator !== null && ator.ativo === true && ator.perfil === PERFIL_MASTER;

const ehAdministradorAtivo = (ator) => ator !== null && ator.ativo === true && ator.perfil === PERFIL_ADMINISTRADOR;

/**
 * Caminho 2: o ADMINISTRADOR tem autorização individual EFETIVA para
 * aquela ação administrativa — a mesma decisão que o middleware tomaria
 * para ele, recalculada com as MESMAS funções de leitura e na mesma
 * ordem já usada por autorizacao-individual.service.js (3I) ao avaliar um
 * delegador:
 *
 *   1. a ação existe, está ativa e tem configuração reconhecível (modo
 *      entre os três válidos, exige_sst estritamente booleano) e não está
 *      em modo NENHUMA — em NENHUMA, usuario_autorizacoes jamais é
 *      consultada, então nenhuma linha ali poderia valer;
 *   2. existe uma linha própria em usuario_autorizacoes para este
 *      usuário e esta ação, NESTA empresa (isolamento garantido pelo
 *      filtro de empresa da consulta e pelas FKs compostas da 019/023);
 *   3. se a ação exigir SST, o ator precisa integrar vinculo_sst — as
 *      três ações administrativas nascem com exige_sst = false (024), mas
 *      a regra é lida do catálogo a cada chamada, nunca presumida;
 *   4. um bloqueio individual (usuario_bloqueios) prevalece sobre a
 *      concessão, como em qualquer outra ação.
 *
 * Nada aqui distingue autorização DIRETA de DELEGADA: as duas são linhas
 * legítimas de usuario_autorizacoes, e a validade da cadeia de delegação
 * já foi garantida na criação pela FK composta da migration 023. Poder
 * ADMINISTRAR nunca implica poder DELEGAR essa autoridade: pode_delegar
 * é atributo da linha, verificado exclusivamente pelo serviço de
 * delegação (3I), que este módulo não chama e não altera.
 *
 * `travar` (correção pós-auditoria da 3Q) escolhe COMO a existência da
 * autorização é verificada, e é a única diferença entre os dois
 * caminhos:
 *
 *   true  — ESCRITA. Lê as linhas de usuario_autorizacoes com FOR
 *     UPDATE, pelo repositório administrativo
 *     (autorizacao-individual.repository.js). Sem isso havia uma
 *     corrida real: a operação travava a linha do ATOR em `usuarios`,
 *     mas lia a autorização sem lock, então uma revogação concorrente
 *     podia commitar no meio da operação e esta seguia até o fim com
 *     uma autoridade que já não existia. A revogação da 3I sempre
 *     passa por FOR UPDATE na mesma linha antes do DELETE, de modo que
 *     travá-la aqui serializa as duas: ou a revogação espera o COMMIT
 *     desta operação, ou esta operação já não encontra a autorização e
 *     é recusada com 403 — nunca o meio-termo. A cascata da FK de
 *     origem (023), que também precisa remover essas linhas, fica
 *     bloqueada pelo mesmo lock.
 *
 *   false — LEITURA. Mantém a consulta de existência de
 *     permissao.repository.js, sem lock: uma consulta HTTP não grava
 *     nada, roda fora de transação (o lock seria liberado no próprio
 *     SELECT) e não deve pôr locks de linha no caminho de leitura.
 *
 * ORDEM DOS LOCKS: usuarios (ator) e só então usuario_autorizacoes —
 * a mesma ordem de delegar() e revogar() na 3I, que é o que evita
 * introduzir um ciclo de deadlock entre as duas famílias de operação.
 *
 * O QUE ESTE LOCK NÃO COBRE, de propósito: SST e bloqueio individual
 * continuam sendo leituras simples. Um vinculo_sst removido ou um
 * usuario_bloqueios inserido por outra transação durante a operação
 * não são serializados aqui — travar o que ainda não existe exigiria
 * SERIALIZABLE ou predicate locks, fora do escopo desta correção. É
 * exatamente a mesma fronteira que a 3I já adota ao avaliar um
 * delegador: trava-se a autorização, não o mundo inteiro.
 */
async function administradorTemAutoridadeEfetiva(executor, empresaId, atorId, acaoAdministrativa, { travar }) {
  const configuracao = await permissaoRepo.buscarConfiguracaoAcao(executor, acaoAdministrativa);
  if (configuracao === null || configuracao.ativo !== true) {
    return false;
  }
  if (!MODOS_AUTORIZACAO_INDIVIDUAL_VALIDOS.has(configuracao.modoAutorizacaoIndividual)
    || typeof configuracao.exigeSst !== 'boolean'
    || configuracao.modoAutorizacaoIndividual === MODO_NENHUMA) {
    return false;
  }

  const concedido = travar
    ? (await autorizacaoRepo.listarPorUsuarioAcaoParaAtualizacao(executor, empresaId, atorId, acaoAdministrativa)).length > 0
    : await permissaoRepo.usuarioTemAutorizacaoIndividual(executor, empresaId, atorId, acaoAdministrativa);
  if (!concedido) {
    return false;
  }

  if (configuracao.exigeSst === true) {
    const integraSst = await permissaoRepo.usuarioIntegraSst(executor, empresaId, atorId);
    if (!integraSst) {
      return false;
    }
  }

  const bloqueado = await permissaoRepo.usuarioTemBloqueio(executor, empresaId, atorId, acaoAdministrativa);
  return !bloqueado;
}

/**
 * Decide a autoridade a partir de um ator JÁ carregado. As duas funções
 * exportadas diferem só no modo de acesso ao banco (travado ou não),
 * nunca no critério — é isso que mantém uma única definição de
 * autoridade, agora com os dois caminhos.
 */
async function temAutoridade(executor, empresaId, atorId, ator, acaoAdministrativa, { travar }) {
  if (temAutoridadeDeMaster(ator)) {
    return true;
  }
  if (!ehAdministradorAtivo(ator)) {
    return false;
  }
  return administradorTemAutoridadeEfetiva(executor, empresaId, atorId, acaoAdministrativa, { travar });
}

/**
 * Para operações de ESCRITA: lê o ator com FOR UPDATE, dentro da transação
 * que vai gravar, garantindo que ele não seja inativado nem mude de perfil
 * entre a verificação e o COMMIT — e, desde a correção de concorrência da
 * 3Q, lê TAMBÉM a autorização individual do ADMINISTRADOR com FOR UPDATE,
 * na mesma transação. É isso que impede que uma revogação concorrente
 * conclua no meio de uma operação já autorizada: ela fica bloqueada até
 * este COMMIT, ou, se commitou antes, a autorização já não é encontrada
 * aqui e a operação é recusada com 403.
 *
 * @param {{query: Function}} client cliente JÁ dentro de uma transação — o
 *   FOR UPDATE só tem efeito útil assim.
 * @param {number} empresaId da sessão autenticada
 * @param {number} atorId da sessão autenticada
 * @param {string} codigo código de erro do domínio que está chamando
 * @param {string} mensagem mensagem pública do domínio que está chamando
 * @param {string} acaoAdministrativa uma das ACOES_ADMINISTRATIVAS, fixa no
 *   serviço que executa a operação — nunca vinda da requisição
 * @returns {Promise<object>} o ator carregado, para quem precisar dele
 * @throws {HttpError} 403 quando não há autoridade por nenhum dos dois caminhos
 */
async function exigirAutoridadeAdministrativa(client, empresaId, atorId, codigo, mensagem, acaoAdministrativa) {
  exigirAcaoAdministrativa(acaoAdministrativa);

  const ator = await usuarioRepo.buscarPorIdParaAtualizacao(client, empresaId, atorId);
  if (!await temAutoridade(client, empresaId, atorId, ator, acaoAdministrativa, { travar: true })) {
    throw HttpError.forbidden(codigo, mensagem);
  }
  return ator;
}

/**
 * Para operações de LEITURA: mesmo critério e os mesmos dois caminhos, sem
 * FOR UPDATE em nada — nem no ator, nem na autorização individual. Uma
 * consulta não grava, roda fora de transação (onde o lock seria liberado
 * no próprio SELECT) e não deve pôr locks de linha no caminho de leitura
 * das rotas HTTP. Perfil e autorização continuam vindo do banco a cada
 * chamada, nunca de um flag do chamador.
 *
 * Existe desde a Subetapa 3M, quando as rotas HTTP passaram a exigir
 * proteção administrativa também nas consultas de grupo (estendida às
 * consultas de permissões na 3N e de vínculos na 3O).
 *
 * @param {{query: Function}} executor pool ou client
 */
async function exigirAutoridadeAdministrativaLeitura(executor, empresaId, atorId, codigo, mensagem, acaoAdministrativa) {
  exigirAcaoAdministrativa(acaoAdministrativa);

  const ator = await usuarioRepo.buscarPorId(executor, empresaId, atorId);
  if (!await temAutoridade(executor, empresaId, atorId, ator, acaoAdministrativa, { travar: false })) {
    throw HttpError.forbidden(codigo, mensagem);
  }
  return ator;
}

module.exports = {
  exigirAutoridadeAdministrativa,
  exigirAutoridadeAdministrativaLeitura,
  ACOES_ADMINISTRATIVAS,
  PERFIL_MASTER,
};
