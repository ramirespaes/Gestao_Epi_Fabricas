'use strict';

const { HttpError } = require('../errors/HttpError');
const permissaoRepo = require('../repositories/permissao.repository');

/**
 * Middlewares de autorização (Bloco 8, Incremento 8).
 *
 * autenticacao.js responde "quem é e de qual empresa"; este módulo responde
 * duas perguntas distintas, cada uma com sua fábrica:
 *
 *   - criarExigirPermissaoRecurso: "este perfil pode visualizar/criar/
 *     editar/excluir NESTE RECURSO (página/módulo)?"
 *   - criarExigirPermissaoAcao: "este perfil pode executar ESTA AÇÃO DE
 *     NEGÓCIO, e este usuário específico não está bloqueado para ela?"
 *
 * As duas dimensões continuam separadas de propósito, como as tabelas que
 * as sustentam (permissoes_recurso e permissoes_acao/usuario_bloqueios):
 * permissão de recurso não concede ação, e permissão de ação não concede
 * acesso a página nenhuma. Uma rota que precisar das duas coisas aplica os
 * dois middlewares em sequência, depois de exigirSessao — isso não é feito
 * aqui, e não há middleware composto.
 *
 * `permissaoRepo.funcao(...)` é sempre chamado por namespace, nunca
 * desestruturado — mesma razão de sessaoRepo em autenticacao.js: permite
 * mock.method nos testes sem mudar o comportamento em produção.
 *
 * CONTRATO DE ERRO, para as duas fábricas: ausência de registro, flag/
 * permitido false, bloqueio individual, ou qualquer resultado que não seja
 * positivo e explícito produzem o MESMO HttpError.forbidden('PERMISSAO_NEGADA',
 * ...) — a distinção entre "nunca configurado", "negado" e "bloqueado
 * individualmente" não é exposta ao cliente. Um contexto de autenticação
 * ausente ou incompleto (req.empresa/req.usuario não populados por
 * exigirSessao, porque o middleware foi montado sem ele) não é tratado como
 * negação de permissão: é erro de programação, e propaga como falha
 * inesperada (500), nunca como 403. Uma falha REAL do PostgreSQL também
 * propaga sem tratamento, pelo mesmo motivo já documentado em
 * autenticacao.js — nada aqui usa try/catch de propósito.
 *
 * GRUPOS DE ACESSO (Bloco 8, Incremento 8, Subetapa 3D): as duas fábricas
 * agora também consultam o grupo principal do usuário (grupos_acesso, via
 * usuarios.grupo_acesso_id) e a permissão configurada para esse grupo —
 * usando exclusivamente as três funções de leitura já aprovadas na
 * Subetapa 3C (buscarGrupoAcessoDoUsuario, buscarPermissaoRecursoGrupo,
 * buscarPermissaoAcaoGrupo). Nenhuma consulta SQL nova é escrita aqui.
 *
 * A fórmula é a mesma nas duas dimensões, resolvida por opiniaoDoGrupo():
 *   1. A permissão do perfil é a base.
 *   2. Se o grupo tiver uma opinião explícita para aquela operação/ação —
 *      TRUE com grupo ativo, ou FALSE com o grupo em qualquer estado — essa
 *      opinião SUBSTITUI a base inteira (não é OR, é override).
 *   3. NULL, ausência de linha de configuração do grupo, ou ausência de
 *      grupo, preservam a base do perfil (herdam).
 *   4. Grupo inativo só pode RESTRINGIR: seu FALSE continua negando, mas
 *      seu TRUE deixa de valer como opinião (herda o perfil) — um grupo
 *      inativo nunca concede o que o perfil já não concedia.
 *
 * MASTER nunca consulta grupo, em nenhuma das duas fábricas — a permissão
 * empresarial de perfil de MASTER não sofre restrição nem concessão de
 * grupo, por decisão explícita desta subetapa.
 *
 * Na autorização por ação, o grupo só participa do modo ALTERNATIVA. Nos
 * modos NENHUMA e OBRIGATORIA o grupo nunca é consultado: NENHUMA já é
 * decidido só pelo perfil, e OBRIGATORIA já exige autorização individual
 * específica que nem perfil nem grupo substituem — consultar o grupo nesses
 * dois modos não mudaria a decisão, só adicionaria uma consulta inútil. Em
 * ALTERNATIVA, depois que perfil+grupo produzem uma base, a autorização
 * individual positiva continua funcionando como exceção final de concessão
 * por cima dessa base (inclusive revertendo uma negativa de grupo), e o
 * bloqueio individual continua sendo a última palavra, sobre tudo.
 *
 * Um grupo cujo NOME seja "SST" não tem nenhum efeito especial em nenhuma
 * das duas fábricas — só vinculo_sst (consultado por usuarioIntegraSst)
 * determina participação real na SST. A permissão de um grupo (mesmo
 * chamado "SST") para APROVAR_SOLICITACAO/REPROVAR_SOLICITACAO nunca
 * substitui usuario_autorizacoes quando o modo for OBRIGATORIA, porque o
 * grupo simplesmente não é consultado nesse modo.
 *
 * EXCEÇÃO INDIVIDUAL DE RECURSO (Bloco 8, Incremento 8, Subetapa 3G):
 * criarExigirPermissaoRecurso, para não-MASTER, agora consulta também
 * usuario_permissoes_recurso (buscarPermissaoRecursoIndividual, já aprovada
 * na Subetapa 3F) — o terceiro e último elo da cadeia de override por
 * recurso: perfil -> grupo -> usuário. A ordem importa: a opinião do
 * usuário é calculada por cima do resultado que perfil+grupo já produziram
 * (ver opiniaoDoGrupo acima), nunca ao lado dele — TRUE individual permite
 * mesmo que perfil e grupo neguem; FALSE individual nega mesmo que perfil
 * e grupo concedam; NULL (ou ausência de linha, ou uma linha com as quatro
 * colunas NULL) preserva o resultado já calculado, sem nenhuma opinião.
 * Resolvida por opiniaoIndividual(), irmã mais simples de opiniaoDoGrupo:
 * sem noção de "ativo/inativo" (usuario_permissoes_recurso não tem essa
 * coluna, e não precisa — uma exceção individual só existe quando alguém
 * decidiu concedê-la, nunca fica "desativada" preservando histórico como
 * um grupo pode). criarExigirPermissaoAcao não é tocada por esta
 * subetapa: usuario_permissoes_recurso é exclusiva da dimensão de
 * recurso, nunca participa de NENHUMA/ALTERNATIVA/OBRIGATORIA nem de
 * vinculo_sst/usuario_autorizacoes/usuario_bloqueios — visualizar uma
 * página não concede nenhuma ação de negócio.
 */

const MENSAGEM_PERMISSAO_NEGADA = 'Sem permissão para esta operação';

// Únicos valores aceitos de acoes.modo_autorizacao_individual — mesmos três
// já impostos pelo CHECK da migration 017. Validado de novo aqui porque o
// middleware nunca deve presumir um valor padrão para uma configuração que
// não reconhece, mesmo que o banco hoje já garanta que só estes três
// valores podem existir.
const MODOS_AUTORIZACAO_INDIVIDUAL_VALIDOS = new Set(['NENHUMA', 'ALTERNATIVA', 'OBRIGATORIA']);

const MAPA_OPERACAO_FLAG = Object.freeze({
  visualizar: 'podeVisualizar',
  criar: 'podeCriar',
  editar: 'podeEditar',
  excluir: 'podeExcluir',
});

// Mesmo formato de permissao.repository.js (FORMATO_RECURSO): identificador
// de página/módulo do frontend ('materials', 'userAdmin'), não o formato
// maiúsculo do catálogo de perfis/ações. Duplicado aqui de propósito — a
// fábrica precisa recusar um recurso malformado na criação, antes de
// qualquer requisição, sem depender de exportar um detalhe interno do
// repositório.
const FORMATO_RECURSO = /^[a-zA-Z][a-zA-Z0-9_]{0,59}$/;

// Mesmo formato de permissao.repository.js (FORMATO_ACAO_CODIGO): contrato
// de acoes.codigo, VARCHAR(60), maiúsculo. Só formato — existência no
// catálogo não é responsabilidade desta fábrica, nem gera consulta
// antecipada ao banco na criação.
const FORMATO_ACAO_CODIGO = /^[A-Z][A-Z0-9_]{0,59}$/;

/**
 * Verdadeiro somente quando exigirSessao (ou equivalente) já populou
 * req.empresa.id e req.usuario.perfil. Nunca olha para body, query, params
 * ou headers — só para o que a camada de autenticação já validou e colocou
 * no request.
 */
function contextoAutenticadoValido(req) {
  return req.empresa != null
    && Number.isInteger(req.empresa.id)
    && req.empresa.id > 0
    && req.usuario != null
    && typeof req.usuario.perfil === 'string'
    && req.usuario.perfil.length > 0;
}

/**
 * Mesma verificação de contextoAutenticadoValido, com a exigência adicional
 * de req.usuario.id. Usada pelas duas fábricas: autorização por ação sempre
 * precisou dele para usuarioTemBloqueio (por usuário, não só por perfil);
 * desde a Subetapa 3D, autorização por recurso também precisa, porque a
 * leitura do grupo principal do usuário (buscarGrupoAcessoDoUsuario) é por
 * usuário. Ausência de usuario.id nunca vira autorização nem negação de
 * negócio — é contexto incompleto, erro de programação (500).
 */
function contextoAutenticadoCompleto(req) {
  return contextoAutenticadoValido(req)
    && Number.isInteger(req.usuario.id)
    && req.usuario.id > 0;
}

/**
 * Resolve a opinião de um grupo (tri-state) sobre uma operação/ação, para
 * substituir (não somar em OR) a base já calculada a partir do perfil.
 *
 * @param {{id: number, ativo: boolean}|null} grupoInfo resultado de
 *   buscarGrupoAcessoDoUsuario — null quando o usuário não tem grupo.
 * @param {boolean|null} valorGrupo o campo tri-state relevante devolvido por
 *   buscarPermissaoRecursoGrupo/buscarPermissaoAcaoGrupo — null tanto para
 *   "grupo sem opinião nessa coluna" quanto para "sem linha nenhuma" (o
 *   próprio chamador já normaliza ausência de linha para null aqui).
 * @returns {boolean|undefined} true/false quando o grupo tem opinião que
 *   substitui a base do perfil; undefined quando não há opinião e a base do
 *   perfil deve prevalecer (grupo inexistente, NULL, ou TRUE de um grupo
 *   inativo — que nunca concede, só um grupo ativo concede).
 */
function opiniaoDoGrupo(grupoInfo, valorGrupo) {
  if (grupoInfo === null) return undefined;
  if (valorGrupo === false) return false;
  if (grupoInfo.ativo === true && valorGrupo === true) return true;
  return undefined;
}

/**
 * Resolve a opinião de uma exceção individual (tri-state) sobre uma
 * operação de recurso, para substituir a base já calculada por perfil e
 * grupo — mesmo papel de opiniaoDoGrupo, mais simples porque
 * usuario_permissoes_recurso não tem noção de "ativo/inativo": uma
 * exceção individual sempre vale quando explícita.
 *
 * @param {boolean|null} valorIndividual o campo tri-state relevante
 *   devolvido por buscarPermissaoRecursoIndividual — null tanto para
 *   "sem opinião nessa coluna" quanto para "sem linha nenhuma".
 * @returns {boolean|undefined} true/false quando a exceção substitui a
 *   base; undefined quando não há opinião e a base (perfil, já com a
 *   opinião do grupo aplicada) deve prevalecer.
 */
function opiniaoIndividual(valorIndividual) {
  if (valorIndividual === true) return true;
  if (valorIndividual === false) return false;
  return undefined;
}


/**
 * DECISÃO por recurso — extraída sem alteração do middleware
 * criarExigirPermissaoRecurso (Bloco 9, Etapa C, Parte C1), para que o
 * middleware e a consulta de permissões efetivas (GET /api/auth/permissoes)
 * usem UMA única interpretação do RBAC. Mesmas consultas, mesma ordem, mesma
 * cadeia perfil -> grupo (opiniaoDoGrupo) -> exceção individual
 * (opiniaoIndividual), MASTER parando no perfil. Devolve a decisão das
 * quatro operações de uma vez: as linhas lidas já trazem as quatro flags,
 * então nenhuma consulta a mais é feita por isso.
 *
 * @param {{query: Function}} executor
 * @param {{empresaId: number, usuarioId: number, perfil: string}} contexto
 *   SEMPRE o da sessão validada — nunca valores vindos do cliente.
 * @param {string} recurso
 * @returns {Promise<{visualizar: boolean, criar: boolean, editar: boolean, excluir: boolean}>}
 */
async function avaliarPermissaoRecurso(executor, { empresaId, usuarioId, perfil }, recurso) {
  const permissao = await permissaoRepo.buscarPermissaoRecurso(executor, empresaId, perfil, recurso);
  const decisao = {};
  for (const [operacao, flag] of Object.entries(MAPA_OPERACAO_FLAG)) {
    decisao[operacao] = permissao !== null && permissao[flag] === true;
  }

  if (perfil !== 'MASTER') {
    const grupo = await permissaoRepo.buscarGrupoAcessoDoUsuario(executor, empresaId, usuarioId);
    if (grupo !== null) {
      const permissaoGrupo = await permissaoRepo.buscarPermissaoRecursoGrupo(executor, empresaId, grupo.id, recurso);
      for (const [operacao, flag] of Object.entries(MAPA_OPERACAO_FLAG)) {
        const opiniaoGrupo = opiniaoDoGrupo(grupo, permissaoGrupo === null ? null : permissaoGrupo[flag]);
        if (opiniaoGrupo !== undefined) decisao[operacao] = opiniaoGrupo;
      }
    }

    const permissaoIndividual = await permissaoRepo.buscarPermissaoRecursoIndividual(executor, empresaId, usuarioId, recurso);
    for (const [operacao, flag] of Object.entries(MAPA_OPERACAO_FLAG)) {
      const opiniaoUsuario = opiniaoIndividual(permissaoIndividual === null ? null : permissaoIndividual[flag]);
      if (opiniaoUsuario !== undefined) decisao[operacao] = opiniaoUsuario;
    }
  }

  return decisao;
}

/**
 * DECISÃO por ação de negócio — extraída sem alteração do middleware
 * criarExigirPermissaoAcao (Parte C1), pela mesma razão de
 * avaliarPermissaoRecurso. Contrato completo (configuração, validade do
 * modo, MASTER / OBRIGATORIA / ALTERNATIVA / NENHUMA, SST, bloqueio) está
 * documentado na fábrica abaixo; esta função é exatamente aquele corpo,
 * devolvendo true/false em vez de chamar next().
 *
 * @param {{query: Function}} executor
 * @param {{empresaId: number, usuarioId: number, perfil: string}} contexto
 * @param {string} acaoCodigo
 * @returns {Promise<boolean>}
 */
async function avaliarPermissaoAcao(executor, { empresaId, usuarioId, perfil }, acaoCodigo) {
  const configuracao = await permissaoRepo.buscarConfiguracaoAcao(executor, acaoCodigo);
  if (configuracao === null || configuracao.ativo !== true) {
    return false;
  }

  // Configuração inválida nega para QUALQUER perfil, MASTER incluído —
  // por isso esta checagem roda antes de qualquer ramificação por perfil,
  // nunca dentro do ramo "não-MASTER". Nenhum valor ausente ou fora do
  // esperado é interpretado com um padrão implícito (ex.: exigeSst
  // ausente NÃO vira false).
  if (!MODOS_AUTORIZACAO_INDIVIDUAL_VALIDOS.has(configuracao.modoAutorizacaoIndividual)
    || typeof configuracao.exigeSst !== 'boolean') {
    return false;
  }

  const ehMaster = perfil === 'MASTER';

  const permissao = await permissaoRepo.buscarPermissaoAcao(executor, empresaId, perfil, acaoCodigo);
  const permitidoPeloPerfil = permissao !== null && permissao.permitido === true;

  let concedido;
  if (ehMaster) {
    concedido = permitidoPeloPerfil;
  } else if (configuracao.modoAutorizacaoIndividual === 'OBRIGATORIA') {
    concedido = await permissaoRepo.usuarioTemAutorizacaoIndividual(executor, empresaId, usuarioId, acaoCodigo);
  } else if (configuracao.modoAutorizacaoIndividual === 'ALTERNATIVA') {
    let baseAposGrupo = permitidoPeloPerfil;

    const grupo = await permissaoRepo.buscarGrupoAcessoDoUsuario(executor, empresaId, usuarioId);
    if (grupo !== null) {
      const permissaoGrupo = await permissaoRepo.buscarPermissaoAcaoGrupo(executor, empresaId, grupo.id, acaoCodigo);
      const opiniao = opiniaoDoGrupo(grupo, permissaoGrupo === null ? null : permissaoGrupo.permitido);
      if (opiniao !== undefined) baseAposGrupo = opiniao;
    }

    concedido = baseAposGrupo
      || await permissaoRepo.usuarioTemAutorizacaoIndividual(executor, empresaId, usuarioId, acaoCodigo);
  } else {
    // Só 'NENHUMA' pode chegar aqui — os outros dois valores válidos já
    // têm ramo próprio acima, e qualquer valor inválido já foi negado
    // pela validação de configuração, antes mesmo de saber o perfil. Grupo
    // não participa deste modo, por decisão explícita da Subetapa 3D.
    concedido = permitidoPeloPerfil;
  }

  if (!concedido) {
    return false;
  }

  if (configuracao.exigeSst && !ehMaster) {
    const integraSst = await permissaoRepo.usuarioIntegraSst(executor, empresaId, usuarioId);
    if (!integraSst) {
      return false;
    }
  }

  const bloqueado = await permissaoRepo.usuarioTemBloqueio(executor, empresaId, usuarioId, acaoCodigo);
  return !bloqueado;
}

/**
 * Fábrica do middleware de autorização por recurso.
 *
 * `operacao` é configuração estática da rota (decidida em código, nunca pelo
 * cliente) e é validada na criação da fábrica, não a cada requisição: uma
 * operação desconhecida é erro de programação e deve falhar imediatamente,
 * sem esperar a primeira requisição para ser descoberta. Não há valor
 * padrão — 'visualizar' nunca é assumido silenciosamente.
 *
 * CONTRATO POR REQUISIÇÃO, desde a Subetapa 3G:
 *   1. Permissão do perfil (buscarPermissaoRecurso) é a base.
 *   2. MASTER para aqui — nunca consulta grupo nem exceção individual,
 *      usa só a base.
 *   3. Não-MASTER: buscarGrupoAcessoDoUsuario; com grupo,
 *      buscarPermissaoRecursoGrupo para este recurso — a opinião do grupo
 *      (ver opiniaoDoGrupo) substitui a base quando existir; sem grupo,
 *      ou sem opinião do grupo, a base permanece a do perfil.
 *   4. Ainda para não-MASTER, sempre (com ou sem grupo):
 *      buscarPermissaoRecursoIndividual para este recurso — a opinião do
 *      usuário (ver opiniaoIndividual) substitui o resultado da etapa
 *      anterior quando existir, por cima de qualquer decisão de grupo.
 *
 * @param {{pool: import('pg').Pool}} dependencias
 * @param {string} recurso identificador de página/módulo
 * @param {'visualizar'|'criar'|'editar'|'excluir'} operacao
 */
function criarExigirPermissaoRecurso({ pool }, recurso, operacao) {
  // Object.hasOwn, não `MAPA_OPERACAO_FLAG[operacao] === undefined`: a
  // segunda forma aceitaria propriedades herdadas de Object.prototype
  // (toString, constructor, __proto__) como se fossem operações válidas.
  if (typeof operacao !== 'string' || !Object.hasOwn(MAPA_OPERACAO_FLAG, operacao)) {
    throw new TypeError(`operação de recurso desconhecida: ${operacao}`);
  }
  if (typeof recurso !== 'string' || !FORMATO_RECURSO.test(recurso)) {
    throw new TypeError('recurso inválido');
  }

  return async function exigirPermissaoRecurso(req, res, next) {
    if (!contextoAutenticadoCompleto(req)) {
      next(new Error('contexto de autenticação ausente ou incompleto para autorização por recurso'));
      return;
    }

    const { empresa, usuario } = req;

    const decisao = await avaliarPermissaoRecurso(pool, { empresaId: empresa.id, usuarioId: usuario.id, perfil: usuario.perfil }, recurso);
    const concedido = decisao[operacao] === true;

    if (!concedido) {
      next(HttpError.forbidden('PERMISSAO_NEGADA', MENSAGEM_PERMISSAO_NEGADA));
      return;
    }

    next();
  };
}

/**
 * Fábrica do middleware de autorização por ação de negócio.
 *
 * `acaoCodigo` é configuração estática da rota, validada só quanto ao
 * FORMATO na criação da fábrica — igual à validação de `recurso` em
 * criarExigirPermissaoRecurso. Existência do código no catálogo `acoes` não
 * é checada aqui: esta fábrica não consulta o banco na criação, só monta o
 * middleware — a existência, a ativação e a configuração (`exige_sst`,
 * `modo_autorizacao_individual`) são resolvidas a cada requisição, porque
 * podem mudar depois que a rota já foi montada.
 *
 * CONTRATO POR REQUISIÇÃO, nesta ordem, cada etapa podendo negar sozinha:
 *
 * 1. Configuração da ação (buscarConfiguracaoAcao): ação inexistente ou
 *    inativa (`ativo = false`) nega imediatamente.
 * 2. Validade da própria configuração: `modo_autorizacao_individual` fora
 *    dos três valores aceitos (NENHUMA/ALTERNATIVA/OBRIGATORIA), ou
 *    `exige_sst` que não seja estritamente booleano, nega imediatamente —
 *    para QUALQUER perfil, MASTER incluído. Uma configuração que o backend
 *    não reconhece nunca é interpretada com um valor padrão implícito (ex.:
 *    "exige_sst ausente vira false"): é tratada como ausência de
 *    autorização, do mesmo jeito que ação inexistente/inativa. Esta etapa
 *    roda ANTES de qualquer ramificação por perfil — o caminho de MASTER
 *    não pula esta validação.
 * 3. Concessão (`concedido`), decidida pelo perfil e pelo modo (já validado
 *    na etapa 2, portanto só pode ser um dos três valores reconhecidos):
 *      MASTER        -> exige permissoes_acao.permitido = true, sempre;
 *                       nunca consulta usuario_autorizacoes, vinculo_sst nem
 *                       grupo.
 *      OBRIGATORIA   -> (não-MASTER) exige usuario_autorizacoes; o valor de
 *                       permissoes_acao é ignorado, inclusive quando ausente
 *                       — a ausência de linha em permissoes_acao NUNCA nega
 *                       antecipadamente aqui, só a ausência da autorização
 *                       individual nega. Grupo nunca é consultado neste
 *                       modo: não substitui a exigência de autorização
 *                       individual (Subetapa 3D).
 *      ALTERNATIVA   -> (não-MASTER) a base é permissoes_acao.permitido =
 *                       true; se o usuário tiver grupo principal, a opinião
 *                       explícita do grupo para esta ação (ver
 *                       opiniaoDoGrupo) SUBSTITUI essa base — inclusive
 *                       negando uma base que o perfil concedia. Por cima do
 *                       resultado, usuario_autorizacoes ainda funciona como
 *                       exceção final de concessão: se a base (já com grupo)
 *                       não concede, a autorização individual pode conceder
 *                       mesmo assim (Subetapa 3D).
 *      NENHUMA       -> (não-MASTER) só permissoes_acao.permitido = true;
 *                       usuario_autorizacoes e grupo nunca são consultados.
 * 4. SST (`exige_sst`): só avaliada se a etapa 3 já concedeu, e só para
 *    não-MASTER — exige usuarioIntegraSst. MASTER dispensa esta etapa por
 *    completo, mesmo quando a ação exige SST para os demais perfis.
 * 5. Bloqueio individual (usuarioTemBloqueio): sempre a última verificação,
 *    para qualquer perfil, MASTER incluído — nenhuma concessão de perfil,
 *    individual ou de SST sobrepõe um bloqueio.
 *
 * Cada etapa só é avaliada se a anterior não já negou — evita consultas
 * desnecessárias sem mudar nenhuma decisão (uma ação já negada nunca deixa
 * de sê-lo por pular uma etapa posterior).
 *
 * @param {{pool: import('pg').Pool}} dependencias
 * @param {string} acaoCodigo código de acoes.codigo
 */
function criarExigirPermissaoAcao({ pool }, acaoCodigo) {
  if (typeof acaoCodigo !== 'string' || !FORMATO_ACAO_CODIGO.test(acaoCodigo)) {
    throw new TypeError('código de ação inválido');
  }

  return async function exigirPermissaoAcao(req, res, next) {
    if (!contextoAutenticadoCompleto(req)) {
      next(new Error('contexto de autenticação ausente ou incompleto para autorização por ação'));
      return;
    }

    const { empresa, usuario } = req;
    const concedido = await avaliarPermissaoAcao(pool, { empresaId: empresa.id, usuarioId: usuario.id, perfil: usuario.perfil }, acaoCodigo);
    if (!concedido) {
      next(HttpError.forbidden('PERMISSAO_NEGADA', MENSAGEM_PERMISSAO_NEGADA));
      return;
    }

    next();
  };
}

module.exports = {
  criarExigirPermissaoRecurso,
  criarExigirPermissaoAcao,
  avaliarPermissaoRecurso,
  avaliarPermissaoAcao,
  OPERACOES_RECURSO: Object.freeze(Object.keys(MAPA_OPERACAO_FLAG)),
};
