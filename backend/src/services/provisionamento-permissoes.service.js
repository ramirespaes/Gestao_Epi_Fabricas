'use strict';

const empresaRepo = require('../repositories/empresa.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const permissaoRepo = require('../repositories/permissao.repository');
const provisionamentoRepo = require('../repositories/permissao-provisionamento.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { ESCOPO_PROVISIONAMENTO_MASTER } = require('../rbac/recursos');

/**
 * Provisionamento das permissões de PERFIL do MASTER (Bloco 9, Etapa B —
 * correção pós-diagnóstico de 23/09/2026).
 *
 * O QUE RESOLVE: o middleware de autorização (Bloco 8) decide, para o
 * MASTER, exclusivamente a partir de permissoes_recurso/permissoes_acao —
 * sem linha, 403. Nenhum código de produção inseria essas linhas; só os
 * testes. Este serviço é o mecanismo de produção, chamado pelo script
 * administrativo scripts/provisionar-permissoes-master.js (e, no futuro,
 * por um fluxo de criação de empresa, se existir — uma única fonte).
 *
 * O QUE NÃO FAZ, por decisão expressa:
 *   - não cria bypass: o middleware não é tocado; o MASTER continua
 *     precisando das linhas (é justamente por isso que elas são criadas);
 *   - não concede "todos os recursos, atuais e futuros": o escopo é
 *     ESCOPO_PROVISIONAMENTO_MASTER (src/rbac/recursos.js) — só o que o
 *     Bloco 9 protege hoje, só as operações que alguma rota exige;
 *   - não sobrescreve nada: linha existente é classificada e RELATADA
 *     (ADEQUADA ou INSUFICIENTE), nunca alterada — `ON CONFLICT DO NOTHING`
 *     no repositório e nenhuma outra escrita aqui;
 *   - não provisiona outros perfis (ADMINISTRADOR/SUPERVISOR/USUARIO são
 *     decisão de configuração de cada empresa, feita pelas telas do RBAC).
 *
 * CLASSIFICAÇÃO de `planejar()` (a mesma em --dry-run e antes de qualquer
 * escrita da execução real — descreve o que a LEITURA encontrou):
 *   AUSENTE        sem linha — candidata a inserção na execução real.
 *   ADEQUADA       linha existente concede todas as operações exigidas.
 *   INSUFICIENTE   linha existente NÃO concede alguma operação exigida
 *                  (ex.: pode_editar = false, ou permitido = false). Fica
 *                  como está e é relatada com as operações faltantes; a
 *                  correção é ato administrativo separado e consciente.
 *   NAO_CATALOGADA (só ações) código ausente ou inativo em `acoes`: não há
 *                  o que conceder; relatado, nada inserido.
 *
 * PLANO FINAL de uma execução real (`resultado.plano`, devolvido por
 * `provisionar()` — correção pós-auditoria independente de 23/09/2026,
 * ajuste v4→v5) NÃO é o plano de `planejar()` sem mais: todo item que
 * planejar() classificou AUSENTE e que esta transação inseriu e confirmou
 * com sucesso é reclassificado como:
 *   INSERIDA       inserida e confirmada NESTA transação. Nunca aparece em
 *                  --dry-run (que não escreve nada) nem em `planejar()`
 *                  isolado — só no plano FINAL de uma execução real.
 * Um item AUSENTE que perdeu a corrida de inserção (ver "CONCORRÊNCIA"
 * abaixo) vira ADEQUADA/INSUFICIENTE pela releitura, nunca INSERIDA (esta
 * transação não foi quem inseriu). `resumir()`, o relatório do script
 * (`formatarPlano`) e o `contexto`/`dadosNovos` da auditoria são sempre
 * calculados sobre esse plano FINAL — nunca sobre o plano lido antes da
 * escrita, que ficaria "ausentes=N" mesmo depois de inserir com sucesso.
 *
 * TRANSAÇÃO E AUDITORIA: a execução real roda em uma transação; se ao menos
 * uma linha foi inserida, grava UMA linha em logs_auditoria
 * (PERMISSOES_MASTER_PROVISIONADAS) na mesma transação, com o ator quando
 * informado (a coluna usuario_id é nullable, migration 012 — execução por
 * operador sem usuário de sistema é permitida e fica marcada em
 * contexto.origem). Só identificadores, códigos e booleanos entram no
 * JSONB — nenhuma chave sensível (migration 014). Dry-run não abre
 * transação, não escreve e não audita.
 *
 * CONCORRÊNCIA NA INSERÇÃO "SE AUSENTE" (correção pós-auditoria
 * independente de 23/09/2026): `planejar()` classifica com base numa
 * leitura anterior à transação de escrita; entre essa leitura e o
 * `INSERT ... ON CONFLICT DO NOTHING`, outra transação pode ter inserido a
 * MESMA linha (empresa+perfil+recurso, ou empresa+perfil+ação) — inclusive
 * com uma permissão NEGADA. Quando isso acontece, o INSERT desta chamada
 * não insere nada (`criado === false`) e a classificação original
 * ("AUSENTE") deixa de ser verdadeira: a linha já existe. Este serviço
 * NUNCA presume sucesso nesse caso — ele RELÊ a permissão realmente
 * persistida, na MESMA transação (uma nova instrução SELECT sob READ
 * COMMITTED sempre enxerga o que foi commitado antes dela, inclusive uma
 * linha que acabou de "vencer" um conflito de INSERT que esta transação
 * esperou), e RECLASSIFICA o item como ADEQUADA (a linha concorrente já
 * satisfaz as operações exigidas) ou INSUFICIENTE (não satisfaz — a linha
 * é preservada intocada e relatada). O plano devolvido ao chamador
 * (`resultado.plano`) reflete esse estado FINAL, não o planejado antes da
 * escrita — é ele que alimenta `resumir()`, o relatório do script e a
 * auditoria. Se a releitura não encontrar linha nenhuma (estado que a
 * semântica de `ON CONFLICT DO NOTHING` não deveria permitir, porque
 * `criado === false` só acontece havendo conflito), o serviço NÃO PRESUME
 * êxito: lança um erro comum (não `ErroProvisionamento`), a transação sofre
 * ROLLBACK, e a chamada é rejeitada — o script trata isso como qualquer
 * falha inesperada (saída ERRO), nunca como sucesso silencioso.
 *
 * Mesmo desenho dos demais serviços: `pool` por parâmetro, módulos chamados
 * por namespace (mock.method nos testes), validação antes de abrir transação.
 */

const PERFIL = ESCOPO_PROVISIONAMENTO_MASTER.perfil;
const ACAO_AUDITORIA = 'PERMISSOES_MASTER_PROVISIONADAS';

const SITUACAO = Object.freeze({
  AUSENTE: 'AUSENTE',
  ADEQUADA: 'ADEQUADA',
  INSUFICIENTE: 'INSUFICIENTE',
  NAO_CATALOGADA: 'NAO_CATALOGADA',
  // Só aparece no PLANO FINAL de uma execução real (nunca em planejar()
  // isolado, nunca em dry-run): item que estava AUSENTE e foi efetivamente
  // inserido E CONFIRMADO por esta transação. Correção pós-auditoria
  // independente de 23/09/2026 (ajuste final da v4→v5): sem esta situação
  // própria, um item inserido com sucesso continuava rotulado "AUSENTE" no
  // relatório/auditoria — o INSERT funcionava, o RELATÓRIO mentia.
  INSERIDA: 'INSERIDA',
});

const FLAG_DA_OPERACAO = Object.freeze({
  visualizar: 'podeVisualizar',
  criar: 'podeCriar',
  editar: 'podeEditar',
  excluir: 'podeExcluir',
});

class ErroProvisionamento extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'ErroProvisionamento';
    this.codigo = codigo;
  }
}

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

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

/** Flags a inserir para um recurso do escopo: true nas operações exigidas, false nas demais. */
function flagsEsperadas(operacoes) {
  return {
    podeVisualizar: operacoes.includes('visualizar'),
    podeCriar: operacoes.includes('criar'),
    podeEditar: operacoes.includes('editar'),
    podeExcluir: operacoes.includes('excluir'),
  };
}

function classificarRecurso({ recurso, operacoes }, atual) {
  const esperado = flagsEsperadas(operacoes);
  if (atual === undefined) {
    return { recurso, operacoes: [...operacoes], situacao: SITUACAO.AUSENTE, faltantes: [], atual: null, esperado };
  }
  const faltantes = operacoes.filter((operacao) => atual[FLAG_DA_OPERACAO[operacao]] !== true);
  return {
    recurso,
    operacoes: [...operacoes],
    situacao: faltantes.length === 0 ? SITUACAO.ADEQUADA : SITUACAO.INSUFICIENTE,
    faltantes,
    atual: { ...atual },
    esperado,
  };
}

/**
 * Reclassifica um item planejado como AUSENTE para o estado FINAL depois de
 * uma inserção CONFIRMADA nesta transação — nunca mais "AUSENTE" (a linha
 * existe agora, com exatamente as flags/permissão que o escopo exige).
 */
function comoInserido(item) {
  if (Object.hasOwn(item, 'recurso')) {
    return {
      recurso: item.recurso, operacoes: item.operacoes, situacao: SITUACAO.INSERIDA,
      faltantes: [], atual: { ...item.esperado }, esperado: item.esperado,
    };
  }
  return { acaoCodigo: item.acaoCodigo, situacao: SITUACAO.INSERIDA, catalogo: 'ATIVA', atual: { permitido: true } };
}

function classificarAcao(acaoCodigo, configuracao, atual) {
  if (configuracao === null || configuracao.ativo !== true) {
    return { acaoCodigo, situacao: SITUACAO.NAO_CATALOGADA, catalogo: configuracao === null ? 'INEXISTENTE' : 'INATIVA', atual: null };
  }
  if (atual === undefined) {
    return { acaoCodigo, situacao: SITUACAO.AUSENTE, catalogo: 'ATIVA', atual: null };
  }
  return {
    acaoCodigo,
    situacao: atual.permitido === true ? SITUACAO.ADEQUADA : SITUACAO.INSUFICIENTE,
    catalogo: 'ATIVA',
    atual: { permitido: atual.permitido },
  };
}

/**
 * Plano de provisionamento para uma empresa: o que está ausente, adequado
 * ou insuficiente, recurso a recurso e ação a ação. Somente leitura.
 *
 * @param {{query: Function}} executor pool ou client
 * @param {{empresaId: number}} dados
 */
async function planejar(executor, { empresaId }) {
  exigirId(empresaId, 'identificador de empresa');

  const empresa = await empresaRepo.buscarPorId(executor, empresaId);
  if (empresa === null) {
    throw new ErroProvisionamento('EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada');
  }
  if (empresa.ativo !== true) {
    throw new ErroProvisionamento('EMPRESA_INATIVA', 'Empresa inativa não recebe provisionamento');
  }

  const recursosDoEscopo = ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((item) => item.recurso);
  const existentes = await provisionamentoRepo.listarPermissoesRecurso(executor, empresaId, PERFIL, recursosDoEscopo);
  const recursos = ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((item) => classificarRecurso(item, existentes.get(item.recurso)));

  const existentesAcao = await provisionamentoRepo.listarPermissoesAcao(executor, empresaId, PERFIL, [...ESCOPO_PROVISIONAMENTO_MASTER.acoes]);
  const acoes = [];
  for (const acaoCodigo of ESCOPO_PROVISIONAMENTO_MASTER.acoes) {
    const configuracao = await permissaoRepo.buscarConfiguracaoAcao(executor, acaoCodigo);
    acoes.push(classificarAcao(acaoCodigo, configuracao, existentesAcao.get(acaoCodigo)));
  }

  return {
    empresa: { id: empresa.id, nome: empresa.nome, ativo: empresa.ativo },
    perfil: PERFIL,
    recursos,
    acoes,
  };
}

/** Totais por situação, para relatório e código de saída do script. */
function resumir(plano) {
  const contar = (itens, situacao) => itens.filter((item) => item.situacao === situacao).length;
  const totais = {};
  for (const situacao of Object.values(SITUACAO)) {
    totais[situacao] = contar(plano.recursos, situacao) + contar(plano.acoes, situacao);
  }
  return totais;
}

/**
 * Executa (ou simula) o provisionamento.
 *
 * @param {import('pg').Pool} pool
 * @param {{empresaId: number, atorId?: number|null, dryRun: boolean, ip?: string|null, dispositivo?: string|null}} dados
 * @returns {Promise<{dryRun: boolean, plano: object, inseridos: {recursos: string[], acoes: string[]}, auditoriaId: string|null}>}
 */
async function provisionar(pool, { empresaId, atorId = null, dryRun, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  if (atorId !== null) {
    exigirId(atorId, 'identificador de ator');
  }
  if (typeof dryRun !== 'boolean') {
    throw new TypeError('dryRun deve ser booleano');
  }

  if (dryRun) {
    const plano = await planejar(pool, { empresaId });
    return { dryRun: true, plano, inseridos: { recursos: [], acoes: [] }, auditoriaId: null };
  }

  return emTransacao(pool, async (client) => {
    if (atorId !== null) {
      const ator = await usuarioRepo.buscarPorId(client, empresaId, atorId);
      if (ator === null) {
        throw new ErroProvisionamento('ATOR_INVALIDO', 'Ator não pertence à empresa informada');
      }
    }

    const plano = await planejar(client, { empresaId });
    const inseridos = { recursos: [], acoes: [] };

    // recursosFinais/acoesFinais substituem, item a item, a classificação
    // planejada pelo estado REAL após a tentativa de escrita — ver o
    // comentário "CONCORRÊNCIA NA INSERÇÃO" no cabeçalho do módulo.
    const recursosFinais = [];
    for (const item of plano.recursos) {
      if (item.situacao !== SITUACAO.AUSENTE) {
        recursosFinais.push(item);
        continue;
      }
      const criado = await provisionamentoRepo.inserirPermissaoRecursoSeAusente(client, {
        empresaId, perfil: PERFIL, recurso: item.recurso, ...item.esperado,
      });
      if (criado) {
        inseridos.recursos.push(item.recurso);
        recursosFinais.push(comoInserido(item));
        continue;
      }
      // Conflito: outra transação inseriu a mesma linha entre o
      // planejamento e esta tentativa. Relê nesta mesma transação — nunca
      // presume o que a linha concorrente concedeu.
      const relidos = await provisionamentoRepo.listarPermissoesRecurso(client, empresaId, PERFIL, [item.recurso]);
      const atualReal = relidos.get(item.recurso);
      if (atualReal === undefined) {
        throw new Error(`estado indeterminado de permissoes_recurso para "${item.recurso}" após conflito de inserção (empresa ${empresaId}, perfil ${PERFIL}) — nenhuma linha encontrada na releitura`);
      }
      recursosFinais.push(classificarRecurso({ recurso: item.recurso, operacoes: item.operacoes }, atualReal));
    }

    const acoesFinais = [];
    for (const item of plano.acoes) {
      if (item.situacao !== SITUACAO.AUSENTE) {
        acoesFinais.push(item);
        continue;
      }
      const criado = await provisionamentoRepo.inserirPermissaoAcaoSeAusente(client, {
        empresaId, perfil: PERFIL, acaoCodigo: item.acaoCodigo, permitido: true,
      });
      if (criado) {
        inseridos.acoes.push(item.acaoCodigo);
        acoesFinais.push(comoInserido(item));
        continue;
      }
      const relidas = await provisionamentoRepo.listarPermissoesAcao(client, empresaId, PERFIL, [item.acaoCodigo]);
      const atualReal = relidas.get(item.acaoCodigo);
      if (atualReal === undefined) {
        throw new Error(`estado indeterminado de permissoes_acao para "${item.acaoCodigo}" após conflito de inserção (empresa ${empresaId}, perfil ${PERFIL}) — nenhuma linha encontrada na releitura`);
      }
      // AUSENTE só ocorre com configuração ATIVA (ver classificarAcao); a
      // linha concorrente é da mesma ação, já catalogada.
      acoesFinais.push(classificarAcao(item.acaoCodigo, { ativo: true }, atualReal));
    }

    // Plano FINAL: reflete o que realmente ficou persistido, não o que foi
    // lido antes da escrita. É este que alimenta resumir(), o relatório do
    // script e a auditoria abaixo.
    const planoFinal = { ...plano, recursos: recursosFinais, acoes: acoesFinais };

    let auditoriaId = null;
    if (inseridos.recursos.length + inseridos.acoes.length > 0) {
      const registro = await auditoriaRepo.registrar(client, {
        empresaId,
        usuarioId: atorId,
        acao: ACAO_AUDITORIA,
        referencia: String(empresaId),
        ip,
        dispositivo,
        contexto: {
          origem: atorId === null ? 'script_administrativo_sem_ator' : 'script_administrativo',
          perfil: PERFIL,
          naoAlterados: {
            recursosInsuficientes: planoFinal.recursos.filter((r) => r.situacao === SITUACAO.INSUFICIENTE).map((r) => ({ recurso: r.recurso, faltantes: r.faltantes })),
            acoesInsuficientes: planoFinal.acoes.filter((a) => a.situacao === SITUACAO.INSUFICIENTE).map((a) => a.acaoCodigo),
            acoesNaoCatalogadas: planoFinal.acoes.filter((a) => a.situacao === SITUACAO.NAO_CATALOGADA).map((a) => a.acaoCodigo),
          },
        },
        dadosNovos: {
          recursos: planoFinal.recursos.filter((r) => inseridos.recursos.includes(r.recurso)).map((r) => ({ recurso: r.recurso, operacoes: r.operacoes })),
          acoes: inseridos.acoes.map((acaoCodigo) => ({ acaoCodigo, permitido: true })),
        },
      });
      auditoriaId = registro.id;
    }

    return { dryRun: false, plano: planoFinal, inseridos, auditoriaId };
  });
}

module.exports = { planejar, provisionar, resumir, SITUACAO, ErroProvisionamento, ACAO_AUDITORIA, PERFIL };
