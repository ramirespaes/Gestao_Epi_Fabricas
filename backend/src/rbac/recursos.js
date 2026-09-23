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
 * criados pelo backend do Bloco 9 que ainda não existem no frontend
 * ('employeeGroups' precisa entrar em `RECURSOS` de js/grupo-permissoes.js
 * na Etapa D/E — pendência registrada).
 *
 * ESCOPO_PROVISIONAMENTO_MASTER é deliberadamente MENOR que a lista de
 * conhecidos: contém SÓ o que o Bloco 9 (Etapas A e B) protege hoje com
 * criarExigirPermissaoRecurso/criarExigirPermissaoAcao, e só as operações
 * que alguma rota exige. Nenhum recurso legado sem rota no backend, nenhum
 * `excluir` (nenhuma rota usa) e nenhuma ação além de MOVIMENTAR_ESTOQUE
 * entram — conceder o que não existe seria concessão vazia, e conceder
 * "tudo, atual e futuro" ao MASTER foi expressamente vedado. Etapas
 * posteriores ampliam este escopo por decisão explícita, uma a uma.
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
const ESCOPO_PROVISIONAMENTO_MASTER = Object.freeze({
  perfil: 'MASTER',
  recursos: Object.freeze([
    Object.freeze({ recurso: 'materials', operacoes: Object.freeze(['visualizar', 'criar', 'editar']) }),
    Object.freeze({ recurso: 'employeeHistory', operacoes: Object.freeze(['visualizar', 'criar', 'editar']) }),
    Object.freeze({ recurso: 'employeeGroups', operacoes: Object.freeze(['visualizar', 'criar', 'editar']) }),
  ]),
  // estoque.routes.js POST /materiais/:id/estoque/movimentar (migrations 003/017)
  acoes: Object.freeze(['MOVIMENTAR_ESTOQUE']),
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

module.exports = {
  FORMATO_RECURSO,
  OPERACOES,
  RECURSOS_LEGADOS,
  RECURSOS_BLOCO_9,
  RECURSOS_CONHECIDOS,
  ESCOPO_PROVISIONAMENTO_MASTER,
  recursoConhecido,
};
