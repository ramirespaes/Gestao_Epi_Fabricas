'use strict';

const { HttpError } = require('../errors/HttpError');
const usuarioRepo = require('../repositories/usuario.repository');
const permissaoRepo = require('../repositories/permissao.repository');
const autorizacaoRepo = require('../repositories/autorizacao-individual.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

/**
 * Serviço de concessão e revogação de autorizações individuais de ação
 * (Bloco 8, Incremento 8, Etapa 5A, Subetapa 3I).
 *
 * Três operações, cada uma numa transação própria, com os dois caminhos de
 * concessão estritamente separados por perfil (relido do banco):
 *   - concederDireta: SÓ MASTER; nasce sem origem (origem_id = NULL);
 *   - delegar: SÓ não-MASTER (um MASTER aqui é recusado: o caminho dele é
 *     concederDireta), a partir de UMA origem própria, explicitada pelo
 *     chamador, com pode_delegar = true;
 *   - revogar: MASTER, ou quem concedeu aquela linha específica. A cascata
 *     sobre descendentes é da FK da migration 023, não deste código.
 *
 * ARQUITETURA: mesmo padrão de login.service.js — recebe `pool` por
 * parâmetro (nunca importa src/config/database.js), abre BEGIN/COMMIT
 * explícito por operação com ROLLBACK em qualquer exceção, e chama os
 * módulos sempre por `modulo.funcao(...)`, nunca desestruturados (permite
 * mock.method nos testes sem afetar produção).
 *
 * AUTORIDADE NUNCA CONFIADA DO CHAMADOR: cada operação recebe o id de quem
 * age (concedidoPor/revogadoPor) e o da empresa, e SEMPRE os revalida
 * contra o banco (existência, `ativo`, `perfil`, pertencimento à empresa),
 * dentro da própria transação e com FOR UPDATE — nunca presume que o
 * chamador já verificou. Nesta subetapa não há rota HTTP nem controller;
 * o contrato é que `empresaId` e o id do ator DEVEM vir do contexto
 * autenticado (sessão) de quem um dia chamar este serviço, nunca de um
 * campo de formulário — o mesmo princípio de criarExigirPermissaoRecurso/
 * Acao em src/middleware/autorizacao.js. Nenhum flag do tipo "éMaster"
 * é aceito como entrada: o perfil é sempre relido do banco.
 *
 * "AUTORIZAÇÃO EFETIVA" DO DELEGADOR (seção 3 da autorização desta
 * subetapa) é recalculada aqui com as MESMAS funções de leitura de
 * permissao.repository.js que o middleware usa — nunca uma segunda fonte
 * de verdade, nunca SQL novo para decidir autorização. O middleware não é
 * modificado nem chamado (é um handler Express, não uma função pura);
 * o que se reproduz é a fórmula já documentada nele, ver
 * delegadorTemAutorizacaoEfetiva() abaixo, que registra por que o caso de
 * grupo não precisa ser consultado.
 *
 * REJEIÇÕES SEM RASTRO: uma tentativa recusada (sem autoridade, dados
 * inválidos, violação de constraint) termina em ROLLBACK e não grava nada
 * — nem em usuario_autorizacoes, nem em logs_auditoria. Diferente do
 * login, onde a tentativa negada precisa persistir para o cooldown, aqui
 * "nada aconteceu" é exatamente o registro correto. Só concessões e
 * revogações que de fato aconteceram são auditadas, na mesma transação da
 * escrita: ou as duas gravam, ou nenhuma.
 *
 * CÓDIGOS DE ERRO: todas as razões de recusa de uma delegação produzem o
 * MESMO HttpError.forbidden('DELEGACAO_NAO_AUTORIZADA') — origem
 * inexistente, de outra empresa, de outra ação, sem pode_delegar, de outro
 * beneficiário, beneficiário inválido, ação inativa, delegador bloqueado
 * ou sem autorização efetiva — mesma disciplina de PERMISSAO_NEGADA no
 * middleware: a razão específica não é exposta, para não permitir sondar
 * a existência de ids ou de autorizações alheias.
 *
 * MODO DA AÇÃO: nenhuma das duas concessões cria autorização individual
 * para ação em modo NENHUMA — nesse modo a autorização nunca é consultada,
 * e a linha só passaria a valer se alguém mudasse o modo depois, ativando
 * de surpresa concessões que ninguém reviu. ALTERNATIVA e OBRIGATORIA
 * seguem aceitando normalmente, sem dispensar exige_sst. Configuração de
 * ação irreconhecível (modo fora dos três válidos, exige_sst não booleano)
 * também impede conceder e delegar, mesma proteção do middleware. Nada
 * disso apaga ou altera linhas preexistentes, nem toca o catálogo.
 *
 * NÃO IMPLEMENTADO NESTA RODADA (fora do escopo autorizado): alterar
 * pode_delegar de uma autorização já existente (é definido só na
 * criação; este serviço nunca executa UPDATE em usuario_autorizacoes, e
 * por isso também nunca reatribui origem_id — a cadeia é imutável depois
 * de criada); rotas HTTP; qualquer operação sobre recurso ou grupo.
 */

const VIOLACAO_FK = '23503';
const VIOLACAO_UNIQUE = '23505';

const PERFIL_MASTER = 'MASTER';

// Mesmos três valores impostos pelo CHECK da migration 017 e revalidados
// pelo middleware. Repetidos aqui pela mesma razão que lá: o serviço nunca
// presume um valor padrão para uma configuração que não reconhece.
const MODO_NENHUMA = 'NENHUMA';
const MODOS_AUTORIZACAO_INDIVIDUAL_VALIDOS = new Set([MODO_NENHUMA, 'ALTERNATIVA', 'OBRIGATORIA']);

const ACAO_AUDITORIA_CONCESSAO = 'AUTORIZACAO_INDIVIDUAL_CONCEDIDA';
const ACAO_AUDITORIA_REVOGACAO = 'AUTORIZACAO_INDIVIDUAL_REVOGADA';

const MSG_AUTOCONCESSAO = 'Não é possível conceder autorização a si mesmo';
const MSG_CONCESSAO_NAO_AUTORIZADA = 'Sem autoridade para conceder esta autorização';
const MSG_CONCESSAO_INVALIDA = 'Concessão inválida';
const MSG_AUTORIZACAO_JA_EXISTE = 'Já existe uma autorização equivalente para este usuário e ação';
const MSG_DELEGACAO_NAO_AUTORIZADA = 'Sem autoridade para delegar esta autorização';
const MSG_AUTORIZACAO_NAO_ENCONTRADA = 'Autorização não encontrada';
const MSG_REVOGACAO_NAO_AUTORIZADA = 'Sem autoridade para revogar esta autorização';

// Teto de ids de descendentes gravados no registro de auditoria de uma
// revogação. O total OBSERVADO é sempre gravado; a lista de ids é uma
// amostra limitada, para que uma cadeia muito grande nunca estoure o
// limite de 16 KiB por JSONB (migration 014) e, com isso, faça a própria
// revogação falhar por causa do log.
const MAX_DESCENDENTES_AUDITADOS = 50;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirBooleano(valor, nome) {
  if (typeof valor !== 'boolean') {
    throw new TypeError(`${nome} deve ser booleano`);
  }
}

function exigirMotivoOpcional(motivo) {
  if (motivo !== null && typeof motivo !== 'string') {
    throw new TypeError('motivo deve ser string ou null');
  }
}

/**
 * Carrega quem está agindo, travando a linha de usuarios para a duração da
 * transação, e exige que exista NESTA empresa e esteja ativo. Ator
 * inexistente, de outra empresa ou inativo recebe o mesmo erro — nunca se
 * distingue qual dos três.
 */
async function carregarAtorAtivo(client, empresaId, atorId, codigo, mensagem) {
  const ator = await usuarioRepo.buscarPorIdParaAtualizacao(client, empresaId, atorId);
  if (ator === null || ator.ativo !== true) {
    throw HttpError.forbidden(codigo, mensagem);
  }
  return ator;
}

/** Beneficiário desta empresa e ativo, travado; null nos demais casos, sem distinguir qual. */
async function carregarBeneficiarioAtivo(client, empresaId, usuarioId) {
  const beneficiario = await usuarioRepo.buscarPorIdParaAtualizacao(client, empresaId, usuarioId);
  if (beneficiario === null || beneficiario.ativo !== true) {
    return null;
  }
  return beneficiario;
}

/**
 * Configuração da ação no catálogo real, aceita para CONCEDER apenas
 * quando passa por três exigências; null em qualquer outro caso, sem
 * distinguir qual delas falhou:
 *
 *   1. a ação existe e está ativa;
 *   2. a configuração é reconhecível — modo_autorizacao_individual é
 *      exatamente um dos três valores válidos e exige_sst é
 *      estritamente booleano. Mesma proteção que o middleware já aplica
 *      antes de qualquer ramificação por perfil: uma configuração que o
 *      backend não reconhece nunca recebe um valor padrão implícito.
 *      Aqui ela impede conceder e delegar, mesmo com a ação ativa;
 *   3. o modo NÃO é NENHUMA. Em NENHUMA, usuario_autorizacoes jamais é
 *      consultada pela autorização: a linha nasceria inerte e só passaria
 *      a valer se alguém, depois, mudasse o modo da ação no catálogo —
 *      ativando de surpresa concessões que ninguém reviu. Só perfil
 *      decide em NENHUMA, e o serviço não cria autorização individual
 *      nenhuma para essas ações. Linhas preexistentes não são tocadas:
 *      esta regra vale para a CRIAÇÃO, nunca apaga nada.
 */
async function carregarAcaoConcedivel(client, acaoCodigo) {
  const configuracao = await permissaoRepo.buscarConfiguracaoAcao(client, acaoCodigo);
  if (configuracao === null || configuracao.ativo !== true) {
    return null;
  }
  if (!MODOS_AUTORIZACAO_INDIVIDUAL_VALIDOS.has(configuracao.modoAutorizacaoIndividual)
    || typeof configuracao.exigeSst !== 'boolean') {
    return null;
  }
  if (configuracao.modoAutorizacaoIndividual === MODO_NENHUMA) {
    return null;
  }
  return configuracao;
}

/**
 * "Autorização efetiva para executar a ação", exigida do delegador — a
 * mesma decisão que src/middleware/autorizacao.js (criarExigirPermissaoAcao)
 * tomaria para ele, recalculada com as MESMAS funções de leitura e na mesma
 * ordem: concessão pelo modo, depois SST se exigida, depois bloqueio.
 *
 * Só chega aqui ação cujo modo é ALTERNATIVA ou OBRIGATORIA:
 * carregarAcaoConcedivel já recusou NENHUMA e configuração inválida antes.
 * Nos dois modos restantes, a concessão se resolve por
 * usuarioTemAutorizacaoIndividual — quem chama já verificou que o
 * delegador é o beneficiário de uma linha própria para ESTA ação (a
 * origem), e essa linha, sozinha, basta tanto em OBRIGATORIA (única
 * exigência de concessão) quanto em ALTERNATIVA (concede como exceção
 * final, independente do que perfil e grupo digam — exatamente como o
 * middleware decide desde a Subetapa 3D). Por isso o ramo de grupo é
 * omitido: não por descuido, mas porque nenhum dos dois modos que
 * chegam aqui depende dele.
 *
 * Isso também é o que garante que a autoridade para DELEGAR nunca vem só
 * de grupo ou de perfil: a exigência de pode_delegar = true é sempre
 * sobre a linha própria do delegador em usuario_autorizacoes, verificada
 * antes de chegar aqui — nenhuma tabela de grupo ou de perfil tem
 * pode_delegar.
 */
async function delegadorTemAutorizacaoEfetiva(client, {
  empresaId, delegadorId, acaoCodigo, configuracao,
}) {
  const concedido = await permissaoRepo.usuarioTemAutorizacaoIndividual(client, empresaId, delegadorId, acaoCodigo);
  if (!concedido) {
    return false;
  }

  if (configuracao.exigeSst === true) {
    const integraSst = await permissaoRepo.usuarioIntegraSst(client, empresaId, delegadorId);
    if (!integraSst) {
      return false;
    }
  }

  const bloqueado = await permissaoRepo.usuarioTemBloqueio(client, empresaId, delegadorId, acaoCodigo);
  return !bloqueado;
}

/**
 * Executa `operacao(client)` dentro de BEGIN/COMMIT, com ROLLBACK em
 * qualquer exceção — HttpError de negócio incluído, de propósito: uma
 * recusa não deve deixar nada gravado (ver docstring do módulo).
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
 * Concessão direta de autorização individual para uma ação — só MASTER.
 *
 * @param {import('pg').Pool} pool
 * @param {{empresaId: number, concedidoPor: number, usuarioId: number, acaoCodigo: string, podeDelegar?: boolean, motivo?: string|null, ip?: string|null, dispositivo?: string|null}} dados
 *   empresaId e concedidoPor DEVEM vir do contexto autenticado do chamador.
 * @returns {Promise<{id: number, empresaId: number, usuarioId: number, acaoCodigo: string, motivo: string|null, autorizadoPor: number, podeDelegar: boolean, origemId: null, criadoEm: Date}>}
 */
async function concederDireta(pool, {
  empresaId, concedidoPor, usuarioId, acaoCodigo, podeDelegar = false, motivo = null, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(concedidoPor, 'identificador de concedente');
  exigirId(usuarioId, 'identificador de beneficiário');
  exigirBooleano(podeDelegar, 'pode_delegar');
  exigirMotivoOpcional(motivo);

  // Falha cedo, sem conexão: autoconcessão nunca é permitida, seja quem
  // for o concedente.
  if (usuarioId === concedidoPor) {
    throw HttpError.badRequest('AUTOCONCESSAO_NAO_PERMITIDA', MSG_AUTOCONCESSAO);
  }

  return emTransacao(pool, async (client) => {
    const concedente = await carregarAtorAtivo(client, empresaId, concedidoPor, 'CONCESSAO_NAO_AUTORIZADA', MSG_CONCESSAO_NAO_AUTORIZADA);
    if (concedente.perfil !== PERFIL_MASTER) {
      throw HttpError.forbidden('CONCESSAO_NAO_AUTORIZADA', MSG_CONCESSAO_NAO_AUTORIZADA);
    }

    const beneficiario = await carregarBeneficiarioAtivo(client, empresaId, usuarioId);
    if (beneficiario === null) {
      throw HttpError.badRequest('CONCESSAO_INVALIDA', MSG_CONCESSAO_INVALIDA);
    }

    // Existência, `ativo`, configuração reconhecível e modo diferente de
    // NENHUMA — ver carregarAcaoConcedivel. O catálogo é só consultado:
    // este serviço nunca o altera, e continua sem dispensar exige_sst nem
    // relaxar OBRIGATORIA, que seguem sendo aplicados no USO da ação.
    const configuracao = await carregarAcaoConcedivel(client, acaoCodigo);
    if (configuracao === null) {
      throw HttpError.badRequest('CONCESSAO_INVALIDA', MSG_CONCESSAO_INVALIDA);
    }

    let criada;
    try {
      criada = await autorizacaoRepo.criar(client, {
        empresaId, usuarioId, acaoCodigo, autorizadoPor: concedidoPor, podeDelegar, origemId: null, motivo,
      });
    } catch (erro) {
      if (erro.code === VIOLACAO_UNIQUE) {
        throw HttpError.conflict('AUTORIZACAO_JA_EXISTE', MSG_AUTORIZACAO_JA_EXISTE);
      }
      throw erro;
    }

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: concedidoPor,
      acao: ACAO_AUDITORIA_CONCESSAO,
      referencia: String(criada.id),
      ip,
      dispositivo,
      contexto: { tipo: 'DIRETA' },
      dadosNovos: {
        usuarioId, acaoCodigo, autorizadoPor: concedidoPor, podeDelegar, origemId: null,
      },
    });

    return criada;
  });
}

/**
 * Concessão delegada — concedente não-MASTER, a partir de uma origem
 * própria. `origemId` é obrigatório e explícito: quando o delegador tem
 * mais de uma autorização para a mesma ação, este serviço nunca escolhe
 * uma por ele. A ação da nova autorização é a da origem — nunca informada
 * pelo chamador, o que já elimina "origem de outra ação" por construção
 * (e a FK composta da migration 023 confirma isso no banco).
 *
 * @param {import('pg').Pool} pool
 * @param {{empresaId: number, concedidoPor: number, origemId: number, usuarioId: number, podeDelegar?: boolean, motivo?: string|null, ip?: string|null, dispositivo?: string|null}} dados
 *   empresaId e concedidoPor DEVEM vir do contexto autenticado do chamador.
 */
async function delegar(pool, {
  empresaId, concedidoPor, origemId, usuarioId, podeDelegar = false, motivo = null, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(concedidoPor, 'identificador de concedente');
  exigirId(origemId, 'identificador de origem');
  exigirId(usuarioId, 'identificador de beneficiário');
  exigirBooleano(podeDelegar, 'pode_delegar');
  exigirMotivoOpcional(motivo);

  if (usuarioId === concedidoPor) {
    throw HttpError.badRequest('AUTOCONCESSAO_NAO_PERMITIDA', MSG_AUTOCONCESSAO);
  }

  return emTransacao(pool, async (client) => {
    const delegador = await carregarAtorAtivo(client, empresaId, concedidoPor, 'DELEGACAO_NAO_AUTORIZADA', MSG_DELEGACAO_NAO_AUTORIZADA);

    // MASTER não delega: o caminho dele é concederDireta, que não depende
    // de origem nenhuma. Manter os dois separados evita que uma concessão
    // de MASTER passe a carregar origem_id (e, com ela, a cascata de
    // revogação de um terceiro) só porque foi criada pela função errada.
    // O perfil vem do banco, relido agora — nunca do chamador.
    if (delegador.perfil === PERFIL_MASTER) {
      throw HttpError.forbidden('DELEGACAO_NAO_AUTORIZADA', MSG_DELEGACAO_NAO_AUTORIZADA);
    }

    // FOR UPDATE: uma revogação concorrente desta origem, ou uma alteração
    // de pode_delegar, fica bloqueada até este COMMIT — ou, se já tiver
    // commitado antes, a origem simplesmente não é mais encontrada. Nunca
    // se delega com base numa autoridade que deixou de existir no meio
    // da operação.
    const origem = await autorizacaoRepo.buscarPorIdParaAtualizacao(client, empresaId, origemId);
    if (origem === null || origem.usuarioId !== concedidoPor || origem.podeDelegar !== true) {
      throw HttpError.forbidden('DELEGACAO_NAO_AUTORIZADA', MSG_DELEGACAO_NAO_AUTORIZADA);
    }

    const beneficiario = await carregarBeneficiarioAtivo(client, empresaId, usuarioId);
    if (beneficiario === null) {
      throw HttpError.forbidden('DELEGACAO_NAO_AUTORIZADA', MSG_DELEGACAO_NAO_AUTORIZADA);
    }

    const configuracao = await carregarAcaoConcedivel(client, origem.acaoCodigo);
    if (configuracao === null) {
      throw HttpError.forbidden('DELEGACAO_NAO_AUTORIZADA', MSG_DELEGACAO_NAO_AUTORIZADA);
    }

    const efetiva = await delegadorTemAutorizacaoEfetiva(client, {
      empresaId, delegadorId: concedidoPor, acaoCodigo: origem.acaoCodigo, configuracao,
    });
    if (!efetiva) {
      throw HttpError.forbidden('DELEGACAO_NAO_AUTORIZADA', MSG_DELEGACAO_NAO_AUTORIZADA);
    }

    let criada;
    try {
      criada = await autorizacaoRepo.criar(client, {
        empresaId, usuarioId, acaoCodigo: origem.acaoCodigo, autorizadoPor: concedidoPor, podeDelegar, origemId, motivo,
      });
    } catch (erro) {
      if (erro.code === VIOLACAO_UNIQUE) {
        throw HttpError.conflict('AUTORIZACAO_JA_EXISTE', MSG_AUTORIZACAO_JA_EXISTE);
      }
      // A FK composta de origem (migration 023) já foi satisfeita pelas
      // verificações acima; se ainda assim falhar, a origem mudou entre a
      // leitura e o INSERT — o que o FOR UPDATE impede — ou o banco está
      // inconsistente. Em ambos os casos, negar sem gravar nada.
      if (erro.code === VIOLACAO_FK) {
        throw HttpError.forbidden('DELEGACAO_NAO_AUTORIZADA', MSG_DELEGACAO_NAO_AUTORIZADA);
      }
      throw erro;
    }

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: concedidoPor,
      acao: ACAO_AUDITORIA_CONCESSAO,
      referencia: String(criada.id),
      ip,
      dispositivo,
      contexto: { tipo: 'DELEGADA', origemId },
      dadosNovos: {
        usuarioId, acaoCodigo: origem.acaoCodigo, autorizadoPor: concedidoPor, podeDelegar, origemId,
      },
    });

    return criada;
  });
}

/**
 * Revoga UMA autorização específica pelo id — nunca todas as linhas de um
 * usuário para a mesma ação. Autoridade: MASTER da empresa, ou quem
 * concedeu exatamente aquela linha (autorizado_por). A remoção dos
 * descendentes é inteiramente da FK ON DELETE CASCADE da migration 023.
 *
 * SOBRE O NÚMERO DE DESCENDENTES: o SELECT recursivo roda ANTES do DELETE
 * e enumera os descendentes OBSERVADOS naquele instante — é a única
 * chance de registrá-los, porque depois da cascata não há mais como
 * consultá-los. Sob READ COMMITTED (isolamento padrão), esse número é uma
 * OBSERVAÇÃO, não a contagem garantida do que a cascata removeu: uma
 * delegação criada por outra transação que commite entre a enumeração e o
 * DELETE cai na cascata sem constar daqui. Por isso o retorno e a
 * auditoria falam em "observados", nunca em "revogados". Fechar essa
 * janela exigiria SERIALIZABLE ou travar a cadeia inteira — fora do
 * escopo desta subetapa, e sem efeito sobre a correção da revogação em
 * si: a cascata do PostgreSQL remove tudo de qualquer forma.
 *
 * @param {import('pg').Pool} pool
 * @param {{empresaId: number, revogadoPor: number, autorizacaoId: number, motivo?: string|null, ip?: string|null, dispositivo?: string|null}} dados
 *   empresaId e revogadoPor DEVEM vir do contexto autenticado do chamador.
 * @returns {Promise<{revogada: object, descendentesObservados: number}>}
 */
async function revogar(pool, {
  empresaId, revogadoPor, autorizacaoId, motivo = null, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(revogadoPor, 'identificador de quem revoga');
  exigirId(autorizacaoId, 'identificador de autorização');
  exigirMotivoOpcional(motivo);

  return emTransacao(pool, async (client) => {
    const ator = await carregarAtorAtivo(client, empresaId, revogadoPor, 'REVOGACAO_NAO_AUTORIZADA', MSG_REVOGACAO_NAO_AUTORIZADA);

    const alvo = await autorizacaoRepo.buscarPorIdParaAtualizacao(client, empresaId, autorizacaoId);
    if (alvo === null) {
      throw HttpError.notFound('AUTORIZACAO_NAO_ENCONTRADA', MSG_AUTORIZACAO_NAO_ENCONTRADA);
    }

    const autorizado = ator.perfil === PERFIL_MASTER || alvo.autorizadoPor === revogadoPor;
    if (!autorizado) {
      throw HttpError.forbidden('REVOGACAO_NAO_AUTORIZADA', MSG_REVOGACAO_NAO_AUTORIZADA);
    }

    const descendentes = await autorizacaoRepo.listarDescendentes(client, empresaId, autorizacaoId);

    // Não pode devolver null: a existência foi confirmada sob FOR UPDATE
    // nesta mesma transação, então nenhuma outra pôde remover a linha.
    const excluida = await autorizacaoRepo.excluir(client, empresaId, autorizacaoId);

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: revogadoPor,
      acao: ACAO_AUDITORIA_REVOGACAO,
      referencia: String(autorizacaoId),
      descricao: motivo,
      ip,
      dispositivo,
      contexto: {
        // "observados": ver a nota sobre READ COMMITTED no docstring de
        // revogar(). São os descendentes vistos imediatamente antes do
        // DELETE, não uma contagem garantida do que a cascata removeu.
        descendentesObservados: {
          total: descendentes.length,
          ids: descendentes.slice(0, MAX_DESCENDENTES_AUDITADOS).map((d) => d.id),
          amostraLimitadaA: MAX_DESCENDENTES_AUDITADOS,
        },
      },
      dadosAnteriores: {
        usuarioId: alvo.usuarioId,
        acaoCodigo: alvo.acaoCodigo,
        autorizadoPor: alvo.autorizadoPor,
        podeDelegar: alvo.podeDelegar,
        origemId: alvo.origemId,
      },
    });

    return { revogada: excluida, descendentesObservados: descendentes.length };
  });
}

module.exports = { concederDireta, delegar, revogar };
