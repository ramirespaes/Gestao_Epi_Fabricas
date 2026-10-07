'use strict';

/**
 * Identificadores de recurso RBAC conhecidos pelo backend (Bloco 9, Etapa B
 * — correção pós-diagnóstico de 23/09/2026).
 *
 * NÃO é um catálogo de banco: `permissoes_recurso.recurso` continua sendo
 * VARCHAR(60) livre, sem tabela própria nem FK (decisão da migration 009,
 * preservada). Esta lista é a fonte única, do lado do backend, para:
 *   - o provisionamento das permissões do MASTER (script administrativo);
 *   - os testes de coerência que garantem que todo `RECURSO` montado em uma
 *     rota de produção com criarExigirPermissaoRecurso está aqui — um
 *     identificador novo não pode ser esquecido no provisionamento.
 *
 * RECURSOS_LEGADOS reproduz `allPages` de frontend/js/main.js (a matriz que
 * a migration 009 diz substituir). RECURSOS_BLOCO_9 são os identificadores
 * criados pelo backend do Bloco 9 ('employeeGroups', presente em `RECURSOS`
 * de js/grupo-permissoes.js desde a Etapa E9).
 *
 * ESCOPO_PROVISIONAMENTO_MASTER é deliberadamente MENOR que a lista de
 * conhecidos: contém SÓ o que as rotas de produção protegem hoje com
 * criarExigirPermissaoRecurso/criarExigirPermissaoAcao, e só as operações
 * que alguma rota exige. Nenhum recurso legado sem rota no backend, nenhum
 * `excluir` (nenhuma rota usa) e nenhuma ação além das exigidas por rota
 * entram — conceder o que não existe seria concessão vazia, e conceder
 * "tudo, atual e futuro" ao MASTER foi expressamente vedado. Cada ampliação
 * é decisão explícita, uma a uma (Bloco 9: Etapas A/B, C3, C6, E9; Bloco 10:
 * 10I, ficha e entrega de EPI).
 */

// Mesmo formato de permissao.repository.js / middleware/autorizacao.js.
const FORMATO_RECURSO = /^[a-zA-Z][a-zA-Z0-9_]{0,59}$/;

const OPERACOES = Object.freeze(['visualizar', 'criar', 'editar', 'excluir']);

const RECURSOS_LEGADOS = Object.freeze([
  'emailsGestao', 'dashboard', 'operations', 'reports', 'materials', 'eligibilityRules',
  'purchases', 'stockValidity', 'availableItems', 'deliveredItems', 'epiFicha',
  'importEmployees', 'newUser', 'employeeHistory', 'request', 'supervisorApproval',
  'stockRequests', 'userAdmin', 'config', 'support', 'lgpd',
]);

const RECURSOS_BLOCO_9 = Object.freeze(['employeeGroups']);

const RECURSOS_CONHECIDOS = Object.freeze([...RECURSOS_LEGADOS, ...RECURSOS_BLOCO_9]);

// Operações que as rotas de produção exigem, por recurso:
//   materials       -> material.routes.js (visualizar/criar/editar) e
//                      estoque.routes.js GET (visualizar)
//   employeeHistory -> funcionario.routes.js (visualizar/criar/editar)
//   employeeGroups  -> grupo-homogeneo-exposicao.routes.js (visualizar/criar/editar)
//   dashboard       -> dashboard.routes.js (visualizar) — Parte C6
//   stockValidity   -> estoque.routes.js GET /estoque/validade (visualizar) — E9
//   operations      -> estoque.routes.js GET /estoque/operacoes (visualizar) — E9
//   epiFicha        -> entrega-epi.routes.js GET /fichas-epi* e /entregas-epi/:id (visualizar) — Bloco 10 (10I)
const ESCOPO_PROVISIONAMENTO_MASTER = Object.freeze({
  perfil: 'MASTER',
  recursos: Object.freeze([
    Object.freeze({ recurso: 'materials', operacoes: Object.freeze(['visualizar', 'criar', 'editar']) }),
    Object.freeze({ recurso: 'employeeHistory', operacoes: Object.freeze(['visualizar', 'criar', 'editar']) }),
    Object.freeze({ recurso: 'employeeGroups', operacoes: Object.freeze(['visualizar', 'criar', 'editar']) }),
    // Parte C3: Itens Disponíveis é consulta — só visualizar, independente de materials.
    Object.freeze({ recurso: 'availableItems', operacoes: Object.freeze(['visualizar']) }),
    // Parte C6: Dashboard é consulta — só visualizar; cada indicador ainda exige a fonte.
    Object.freeze({ recurso: 'dashboard', operacoes: Object.freeze(['visualizar']) }),
    // E9: Validade e Operações de estoque são consultas com permissão própria — só visualizar.
    Object.freeze({ recurso: 'stockValidity', operacoes: Object.freeze(['visualizar']) }),
    Object.freeze({ recurso: 'operations', operacoes: Object.freeze(['visualizar']) }),
    // 10I: a ficha e o histórico de entregas são consulta — só visualizar; entregar é a ação abaixo.
    Object.freeze({ recurso: 'epiFicha', operacoes: Object.freeze(['visualizar']) }),
    // Decisão de 05/10/2026 (supera a do 12E/12F): o MASTER tem autoridade máxima na
    // empresa e recebe o Pedido de EPI — solicitacao-epi.routes.js: minhas/detalhe
    // (visualizar), criar (criar) e cancelar (editar). As ações da SST
    // (APROVAR/REPROVAR/ENCERRAR_SOLICITACAO) continuam fora: exigem vínculo SST,
    // que não se aplica ao MASTER, e a autodecisão segue proibida.
    Object.freeze({ recurso: 'request', operacoes: Object.freeze(['visualizar', 'criar', 'editar']) }),
  ]),
  // estoque.routes.js: entradas e baixas por lote; entrega-epi.routes.js: entrega e seu contexto (migrations 003/017)
  acoes: Object.freeze(['ENTRADA_ESTOQUE', 'BAIXA_ESTOQUE', 'REALIZAR_ENTREGA', 'IMPORTAR_FUNCIONARIOS']),
});

for (const recurso of RECURSOS_CONHECIDOS) {
  if (!FORMATO_RECURSO.test(recurso)) {
    throw new Error(`recurso conhecido com formato inválido: ${recurso}`);
  }
}
if (new Set(RECURSOS_CONHECIDOS).size !== RECURSOS_CONHECIDOS.length) {
  throw new Error('lista de recursos conhecidos contém duplicata');
}
for (const { recurso, operacoes } of ESCOPO_PROVISIONAMENTO_MASTER.recursos) {
  if (!RECURSOS_CONHECIDOS.includes(recurso)) {
    throw new Error(`escopo de provisionamento cita recurso desconhecido: ${recurso}`);
  }
  for (const operacao of operacoes) {
    if (!OPERACOES.includes(operacao)) {
      throw new Error(`escopo de provisionamento cita operação desconhecida: ${operacao}`);
    }
  }
}

function recursoConhecido(recurso) {
  return typeof recurso === 'string' && RECURSOS_CONHECIDOS.includes(recurso);
}

// Nome de apresentação dos recursos que as rotas realmente protegem (o escopo acima). Vive aqui, do lado do backend,
// para a tela de permissões do usuário montar o catálogo a partir da API, sem lista de páginas no navegador.
const ROTULOS_RECURSOS = Object.freeze({
  materials: 'Materiais',
  employeeHistory: 'Funcionários',
  employeeGroups: 'Gestão de GHE',
  availableItems: 'Itens disponíveis',
  dashboard: 'Dashboard',
  stockValidity: 'Validade do estoque',
  operations: 'Operações de estoque',
  epiFicha: 'Ficha de EPI',
  request: 'Pedido de EPI',
});
for (const { recurso } of ESCOPO_PROVISIONAMENTO_MASTER.recursos) {
  if (typeof ROTULOS_RECURSOS[recurso] !== 'string') {
    throw new Error(`recurso do escopo sem rótulo de apresentação: ${recurso}`);
  }
}

/** Recursos e operações que alguma rota exige de fato (o único conjunto em que uma permissão tem efeito real). */
const RECURSOS_COM_EFEITO = Object.freeze(ESCOPO_PROVISIONAMENTO_MASTER.recursos.map((r) => Object.freeze({
  recurso: r.recurso, rotulo: ROTULOS_RECURSOS[r.recurso], operacoes: r.operacoes,
})));

/**
 * Ações do catálogo (`acoes`) que o backend de fato aplica (rota, serviço ou autoridade administrativa). Só estas
 * aparecem na tela de permissões do usuário: uma ação sem uso no código seria um controle sem efeito. Há teste que
 * confere o uso de cada código e que nenhum outro código do catálogo é usado sem estar aqui.
 */
const ACOES_COM_EFEITO = Object.freeze([
  'ENTRADA_ESTOQUE', 'BAIXA_ESTOQUE', 'IMPORTAR_FUNCIONARIOS', 'REALIZAR_ENTREGA', 'APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO',
  'GERENCIAR_USUARIOS', 'ADMINISTRAR_GRUPOS_ACESSO', 'ADMINISTRAR_PERMISSOES_GRUPO', 'ADMINISTRAR_VINCULOS_GRUPO',
]);

module.exports = {
  ACOES_COM_EFEITO,
  ROTULOS_RECURSOS,
  RECURSOS_COM_EFEITO,
  FORMATO_RECURSO,
  OPERACOES,
  RECURSOS_LEGADOS,
  RECURSOS_BLOCO_9,
  RECURSOS_CONHECIDOS,
  ESCOPO_PROVISIONAMENTO_MASTER,
  recursoConhecido,
};
