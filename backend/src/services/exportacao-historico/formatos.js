'use strict';

/**
 * Formatos da exportação do Histórico de Funcionários (pacote I). Fonte única dos ids aceitos pela rota, do tipo MIME e
 * da extensão do arquivo; o frontend repete a mesma lista (conferido por teste). Sem dependência pesada: o schema a usa.
 */
const FORMATOS = Object.freeze([
  Object.freeze({ id: 'pdf', extensao: 'pdf', mime: 'application/pdf' }),
  Object.freeze({ id: 'xlsx', extensao: 'xlsx', mime: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }),
]);

const IDS_FORMATOS = Object.freeze(FORMATOS.map((f) => f.id));

module.exports = { FORMATOS, IDS_FORMATOS };
