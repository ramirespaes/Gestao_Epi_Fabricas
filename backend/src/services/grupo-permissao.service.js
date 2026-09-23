'use strict';

const { HttpError } = require('../errors/HttpError');
const grupoRepo = require('../repositories/grupo-acesso.repository');
const grupoPermissaoRepo = require('../repositories/grupo-permissao.repository');
const permissaoRepo = require('../repositories/permissao.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const autoridade = require('./autoridade-administrativa');

/**
 * Serviço de configuração das permissões dos grupos de acesso (Bloco 8,
 * Incremento 8, Etapa 5A, Subetapa 3K).
 *
 * Quatro operações sobre grupo_permissoes_recurso e grupo_permissoes_acao
 * (migration 021): configurarRecurso, configurarAcao e as duas leituras
 * correspondentes. As duas de escrita são transacionais e auditadas.
 *
 * ARQUITETURA: mesmos padrões já aprovados — `pool` por parâmetro,
 * BEGIN/COMMIT com ROLLBACK em qualquer exceção, módulos chamados por
 * namespace (nunca desestruturados, para permitir mock.method nos testes),
 * e a autoridade administrativa resolvida no ponto único compartilhado
 * (autoridade-administrativa.js): MASTER ativo da própria empresa, com
 * perfil RELIDO do banco sob FOR UPDATE. Nenhum flag `isMaster`, nenhum
 * `perfil` e nenhum `empresa_id` vindos do chamador são aceitos como fonte
 * de autoridade; empresaId e atorId DEVEM vir da sessão autenticada.
 * Desde a Subetapa 3Q, além do MASTER, um ADMINISTRADOR expressamente
 * autorizado para ADMINISTRAR_PERMISSOES_GRUPO (autorização individual
 * nominal, concedida pelo MASTER) também administra estas quatro
 * operações — e nenhuma outra: quem recebe essa ação não ganha, com
 * ela, o direito de criar grupos (3J) nem de mover pessoas entre eles
 * (3L). Ter o perfil ADMINISTRADOR, sozinho, continua não concedendo
 * nada. A regra segue inteiramente em autoridade-administrativa.js;
 * este serviço só declara QUAL ação administrativa está em jogo.
 *
 * TRI-STATE, PRESERVADO EM CADA OPERAÇÃO INDEPENDENTEMENTE:
 *   TRUE  = o grupo concede;
 *   FALSE = o grupo nega;
 *   NULL  = o grupo não opina, herda do perfil.
 * Em configurarRecurso, cada uma das quatro operações é independente:
 * campo AUSENTE preserva o valor atual; campo informado como null passa a
 * herdar; true concede; false nega. Alterar "excluir" jamais reescreve
 * "visualizar", "criar" ou "editar" — e FALSE nunca é convertido em NULL,
 * nem TRUE é presumido em lugar nenhum.
 *
 * A composição parcial é resolvida AQUI, dentro da transação: o estado
 * atual é lido depois de travar o grupo, mesclado com o que foi informado,
 * e o resultado final completo é gravado. Isso também é o que permite
 * auditar "anterior" e "novo" de verdade e detectar que nada mudou.
 *
 * AÇÕES — o catálogo real manda: a ação precisa existir e estar ativa, e
 * sua configuração precisa ser reconhecível (modo entre os três válidos,
 * exige_sst estritamente booleano — mesma proteção do middleware e da
 * Subetapa 3I). Além disso, conceder ou negar (TRUE/FALSE) por grupo só é
 * aceito em ações atualmente em modo ALTERNATIVA:
 *   - NENHUMA: só o perfil decide; uma configuração de grupo nasceria
 *     inerte e só passaria a valer se alguém mudasse o modo depois,
 *     ativando de surpresa uma concessão que ninguém reviu;
 *   - OBRIGATORIA: o grupo não substitui a autorização individual
 *     obrigatória nem o vinculo_sst — uma opinião de grupo aqui seria, na
 *     melhor das hipóteses, enganosa.
 * Gravar NULL (retirar a opinião do grupo) continua permitido em qualquer
 * ação existente e ativa: é justamente como se limpa uma configuração que
 * ficou obsoleta porque o modo da ação mudou depois. Nada aqui altera o
 * modo de nenhuma ação nem toca o catálogo.
 *
 * GRUPO INATIVO: configurar as permissões de um grupo inativo é permitido
 * e NÃO o reativa — nenhuma operação deste serviço escreve em
 * grupos_acesso. As configurações ficam armazenadas e a regra já aprovada
 * no middleware continua valendo tal como está (grupo ativo: TRUE concede,
 * FALSE nega, NULL herda; grupo inativo: FALSE continua negando, TRUE não
 * concede, NULL herda). Reativar o grupo — operação da Subetapa 3J — é que
 * faz os TRUE voltarem a produzir efeito.
 *
 * CONCORRÊNCIA: toda escrita começa travando a linha do grupo em
 * grupos_acesso com FOR UPDATE, como a Subetapa 3J. Como todas as edições
 * de permissão do mesmo grupo passam por esse mesmo lock, elas se
 * serializam entre si — e também contra uma inativação/reativação
 * concorrente do grupo.
 *
 * SEM MUDANÇA EFETIVA, SEM GRAVAÇÃO E SEM AUDITORIA: se a configuração
 * resultante for idêntica à atual, nada é escrito e nada é auditado — a
 * operação devolve `alterado: false`.
 *
 * REJEIÇÕES SEM RASTRO: qualquer recusa termina em ROLLBACK, sem gravar em
 * grupo_permissoes_* nem em logs_auditoria.
 *
 * LEITURA TAMBÉM PROTEGIDA (ajuste da Subetapa 3N): listarRecursos e
 * listarAcoes nasceram, na 3K, exigindo só a existência do grupo na
 * empresa informada, sem checar autoridade — correto para o estado da
 * arquitetura na época, quando nada consumia este serviço por HTTP. A
 * Subetapa 3N expõe estas duas funções por rota (GET), e a mesma decisão
 * já tomada para grupo-acesso.service.js na Subetapa 3M se aplica aqui:
 * consultar a configuração de permissões de um grupo é informação
 * administrativa, então as duas leituras passam a exigir a mesma
 * autoridade das escritas, pela variante de leitura do ponto único
 * (autoridade-administrativa.js, sem FOR UPDATE). Isso é um ajuste
 * mínimo e documentado desta rodada, não uma reabertura da 3K: nenhuma
 * das quatro operações de escrita muda, e a única mudança de contrato é
 * o novo parâmetro `atorId`, agora obrigatório nas duas listagens.
 */

const MODO_ALTERNATIVA = 'ALTERNATIVA';
const MODOS_AUTORIZACAO_INDIVIDUAL_VALIDOS = new Set(['NENHUMA', MODO_ALTERNATIVA, 'OBRIGATORIA']);

const OPERACOES_RECURSO = Object.freeze(['podeVisualizar', 'podeCriar', 'podeEditar', 'podeExcluir']);

const ACAO_AUDITORIA_RECURSO = 'GRUPO_PERMISSAO_RECURSO_CONFIGURADA';
const ACAO_AUDITORIA_ACAO = 'GRUPO_PERMISSAO_ACAO_CONFIGURADA';

const MSG_NAO_AUTORIZADO = 'Sem autoridade para configurar permissões de grupo';
const MSG_GRUPO_NAO_ENCONTRADO = 'Grupo de acesso não encontrado';
const MSG_SEM_ALTERACAO = 'Nenhuma operação informada para configurar';
const MSG_ACAO_INVALIDA = 'Ação inválida para configuração de grupo';
const MSG_ACAO_NAO_ALTERNATIVA = 'Esta ação só aceita configuração de grupo quando seu modo for ALTERNATIVA';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirTriState(valor, nome) {
  if (valor !== null && typeof valor !== 'boolean') {
    throw new TypeError(`${nome} deve ser true, false ou null`);
  }
}

/**
 * Lê as operações efetivamente INFORMADAS pelo chamador, distinguindo
 * "ausente" (a chave não veio) de "informada como null" (veio, e pede
 * herança). `undefined` explícito é tratado como ausência, para que
 * `{ podeCriar: undefined }` não signifique nada diferente de omitir.
 */
function extrairOperacoesInformadas(dados) {
  const informadas = {};
  for (const operacao of OPERACOES_RECURSO) {
    if (Object.hasOwn(dados, operacao) && dados[operacao] !== undefined) {
      exigirTriState(dados[operacao], operacao);
      informadas[operacao] = dados[operacao];
    }
  }
  return informadas;
}

/** Só as quatro operações, para comparar e auditar sem ruído de metadados. */
const instantaneoRecurso = (configuracao) => (configuracao === null ? null : {
  podeVisualizar: configuracao.podeVisualizar,
  podeCriar: configuracao.podeCriar,
  podeEditar: configuracao.podeEditar,
  podeExcluir: configuracao.podeExcluir,
});

const ESTADO_RECURSO_VAZIO = Object.freeze({
  podeVisualizar: null, podeCriar: null, podeEditar: null, podeExcluir: null,
});

const mesmasOperacoes = (a, b) => OPERACOES_RECURSO.every((operacao) => a[operacao] === b[operacao]);

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
 * Trava o grupo da empresa autenticada e devolve-o. Grupo inexistente NESTA
 * empresa — inclusive um id real de outra empresa — é 404: conhecer o id
 * não dá acesso nenhum. Grupo inativo é devolvido normalmente: configurar
 * suas permissões é legítimo e não o reativa.
 */
async function travarGrupoDaEmpresa(client, empresaId, grupoId) {
  const grupo = await grupoRepo.buscarPorIdParaAtualizacao(client, empresaId, grupoId);
  if (grupo === null) {
    throw HttpError.notFound('GRUPO_NAO_ENCONTRADO', MSG_GRUPO_NAO_ENCONTRADO);
  }
  return grupo;
}

/**
 * Configuração da ação no catálogo real, aceita para configuração de grupo
 * apenas quando existe, está ativa e tem configuração reconhecível.
 * Devolve null nos demais casos, sem distinguir qual falhou.
 */
async function carregarAcaoConfiguravel(client, acaoCodigo) {
  const configuracao = await permissaoRepo.buscarConfiguracaoAcao(client, acaoCodigo);
  if (configuracao === null || configuracao.ativo !== true) {
    return null;
  }
  if (!MODOS_AUTORIZACAO_INDIVIDUAL_VALIDOS.has(configuracao.modoAutorizacaoIndividual)
    || typeof configuracao.exigeSst !== 'boolean') {
    return null;
  }
  return configuracao;
}

/**
 * Configura as permissões de um grupo sobre um recurso (página/módulo).
 *
 * Cada operação é independente: informe só as que quer mudar. Operação
 * ausente preserva o valor atual; `null` passa a herdar do perfil; `true`
 * concede; `false` nega.
 *
 * @param {import('pg').Pool} pool
 * @param {{empresaId: number, atorId: number, grupoId: number, recurso: string,
 *          podeVisualizar?: boolean|null, podeCriar?: boolean|null,
 *          podeEditar?: boolean|null, podeExcluir?: boolean|null,
 *          ip?: string|null, dispositivo?: string|null}} dados
 *   empresaId e atorId DEVEM vir do contexto autenticado do chamador.
 * @returns {Promise<{configuracao: object, alterado: boolean}>}
 */
async function configurarRecurso(pool, dados) {
  const {
    empresaId, atorId, grupoId, recurso, ip = null, dispositivo = null,
  } = dados;

  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(grupoId, 'identificador de grupo');
  const informadas = extrairOperacoesInformadas(dados);

  return emTransacao(pool, async (client) => {
    await autoridade.exigirAutoridadeAdministrativa(client, empresaId, atorId, 'GRUPO_PERMISSAO_NAO_AUTORIZADA', MSG_NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.PERMISSOES_GRUPO);

    if (Object.keys(informadas).length === 0) {
      throw HttpError.badRequest('GRUPO_PERMISSAO_SEM_ALTERACAO', MSG_SEM_ALTERACAO);
    }

    await travarGrupoDaEmpresa(client, empresaId, grupoId);

    const atual = await grupoPermissaoRepo.buscarRecurso(client, empresaId, grupoId, recurso);
    const anterior = instantaneoRecurso(atual) ?? { ...ESTADO_RECURSO_VAZIO };
    const novo = { ...anterior, ...informadas };

    if (atual !== null && mesmasOperacoes(anterior, novo)) {
      return { configuracao: atual, alterado: false };
    }

    const configuracao = await grupoPermissaoRepo.salvarRecurso(client, {
      empresaId, grupoAcessoId: grupoId, recurso, ...novo,
    });

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA_RECURSO,
      referencia: String(grupoId),
      ip,
      dispositivo,
      contexto: { recurso, operacoesInformadas: Object.keys(informadas), criouConfiguracao: atual === null },
      dadosAnteriores: instantaneoRecurso(atual),
      dadosNovos: instantaneoRecurso(configuracao),
    });

    return { configuracao, alterado: true };
  });
}

/**
 * Configura a permissão de um grupo sobre uma ação de negócio.
 *
 * `permitido` é obrigatório e tri-state. TRUE/FALSE só são aceitos em
 * ações atualmente em modo ALTERNATIVA; NULL (retirar a opinião do grupo)
 * é aceito em qualquer ação existente e ativa.
 *
 * @param {import('pg').Pool} pool
 * @param {{empresaId: number, atorId: number, grupoId: number, acaoCodigo: string,
 *          permitido: boolean|null, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<{configuracao: object, alterado: boolean}>}
 */
async function configurarAcao(pool, {
  empresaId, atorId, grupoId, acaoCodigo, permitido, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(grupoId, 'identificador de grupo');
  exigirTriState(permitido, 'permitido');

  return emTransacao(pool, async (client) => {
    await autoridade.exigirAutoridadeAdministrativa(client, empresaId, atorId, 'GRUPO_PERMISSAO_NAO_AUTORIZADA', MSG_NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.PERMISSOES_GRUPO);

    await travarGrupoDaEmpresa(client, empresaId, grupoId);

    const configuracaoAcao = await carregarAcaoConfiguravel(client, acaoCodigo);
    if (configuracaoAcao === null) {
      throw HttpError.badRequest('GRUPO_PERMISSAO_ACAO_INVALIDA', MSG_ACAO_INVALIDA);
    }
    // Conceder ou negar por grupo só faz sentido onde o grupo participa da
    // decisão. Retirar a opinião (null) continua permitido em qualquer
    // ação válida — é assim que se limpa uma configuração que ficou
    // obsoleta depois de o catálogo mudar.
    if (permitido !== null && configuracaoAcao.modoAutorizacaoIndividual !== MODO_ALTERNATIVA) {
      throw HttpError.conflict('GRUPO_PERMISSAO_ACAO_NAO_ALTERNATIVA', MSG_ACAO_NAO_ALTERNATIVA);
    }

    const atual = await grupoPermissaoRepo.buscarAcao(client, empresaId, grupoId, acaoCodigo);

    if (atual !== null && atual.permitido === permitido) {
      return { configuracao: atual, alterado: false };
    }

    const configuracao = await grupoPermissaoRepo.salvarAcao(client, {
      empresaId, grupoAcessoId: grupoId, acaoCodigo, permitido,
    });

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA_ACAO,
      referencia: String(grupoId),
      ip,
      dispositivo,
      contexto: {
        acaoCodigo,
        modoAutorizacaoIndividual: configuracaoAcao.modoAutorizacaoIndividual,
        criouConfiguracao: atual === null,
      },
      dadosAnteriores: atual === null ? null : { permitido: atual.permitido },
      dadosNovos: { permitido: configuracao.permitido },
    });

    return { configuracao, alterado: true };
  });
}

/**
 * Lista as configurações de recurso de um grupo da empresa autenticada.
 *
 * Leitura: não abre transação, mas — desde a Subetapa 3N — exige a MESMA
 * autoridade administrativa das operações de escrita deste serviço,
 * pela variante de leitura do ponto único (autoridade-administrativa.js,
 * sem FOR UPDATE, porque nada será gravado). Continua estritamente
 * isolada por empresa: um id de outra empresa simplesmente não é
 * encontrado, e um ator inexistente nesta empresa nem chega a essa
 * verificação (a autoridade já recusa antes).
 *
 * @param {{empresaId: number, atorId: number, grupoId: number}} dados
 *   empresaId e atorId DEVEM vir do contexto autenticado do chamador.
 * @throws {HttpError} 403 sem autoridade; 404 quando o grupo não existe NESTA empresa
 */
async function listarRecursos(pool, { empresaId, atorId, grupoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(grupoId, 'identificador de grupo');

  await autoridade.exigirAutoridadeAdministrativaLeitura(pool, empresaId, atorId, 'GRUPO_PERMISSAO_NAO_AUTORIZADA', MSG_NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.PERMISSOES_GRUPO);

  const grupo = await grupoRepo.buscarPorId(pool, empresaId, grupoId);
  if (grupo === null) {
    throw HttpError.notFound('GRUPO_NAO_ENCONTRADO', MSG_GRUPO_NAO_ENCONTRADO);
  }

  return grupoPermissaoRepo.listarRecursosDoGrupo(pool, empresaId, grupoId);
}

/**
 * Lista as configurações de ação de um grupo da empresa autenticada.
 * Mesma proteção e mesmo contrato de listarRecursos, desde a Subetapa 3N.
 */
async function listarAcoes(pool, { empresaId, atorId, grupoId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(grupoId, 'identificador de grupo');

  await autoridade.exigirAutoridadeAdministrativaLeitura(pool, empresaId, atorId, 'GRUPO_PERMISSAO_NAO_AUTORIZADA', MSG_NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.PERMISSOES_GRUPO);

  const grupo = await grupoRepo.buscarPorId(pool, empresaId, grupoId);
  if (grupo === null) {
    throw HttpError.notFound('GRUPO_NAO_ENCONTRADO', MSG_GRUPO_NAO_ENCONTRADO);
  }

  return grupoPermissaoRepo.listarAcoesDoGrupo(pool, empresaId, grupoId);
}

module.exports = {
  configurarRecurso,
  configurarAcao,
  listarRecursos,
  listarAcoes,
};
