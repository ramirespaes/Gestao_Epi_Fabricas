'use strict';

const { TOGGLES } = require('./toggles');

/**
 * Avisos informativos sobre uma lista de acessos ON/OFF — no usuário, o resultado efetivo; no grupo, a CONFIGURAÇÃO do
 * grupo (ligado = o grupo concede). Só informam: nada é revogado, ativado ou impedido, e o RBAC não muda.
 *
 * FUNCIONARIOS_SEM_VISUALIZAR: algum acesso que depende da leitura de Funcionários (Cadastrar/Editar Funcionário, pelas
 * `dependencias` do catálogo) está ligado e a leitura (Histórico de Funcionários) não está. A página Cadastro de
 * Colaboradores abre com a leitura, então pode sair do menu mesmo com as operações concedidas.
 *
 * EXPORTAR_HISTORICO_SEM_VISUALIZAR (pacote J): Exportar Histórico de Funcionários ligado e a leitura não. Ligado não é
 * autorizado: a exportação exige as duas (exportacao-historico-autorizacao.service.js). Exportar não tem dependência no
 * catálogo (ligar não liga a leitura), por isso a regra é própria.
 */
const FUNCIONARIOS_SEM_VISUALIZAR = 'FUNCIONARIOS_SEM_VISUALIZAR';
const EXPORTAR_HISTORICO_SEM_VISUALIZAR = 'EXPORTAR_HISTORICO_SEM_VISUALIZAR';
const RECURSO_FUNCIONARIOS = 'employeeHistory';
const EXPORTAR = TOGGLES.find((t) => t.regra.tipo === 'ACAO' && t.regra.codigo === 'EXPORTAR_HISTORICO_FUNCIONARIOS').id;

const LEITURA = TOGGLES.find((t) => t.regra.tipo === 'RECURSO' && t.regra.recurso === RECURSO_FUNCIONARIOS
  && t.regra.operacoes.length === 1 && t.regra.operacoes[0] === 'visualizar').id;
const DEPENDENTES = TOGGLES
  .filter((t) => (t.dependencias ?? []).some((d) => d.tipo === 'RECURSO' && d.recurso === RECURSO_FUNCIONARIOS))
  .map((t) => t.id);

/** @param {{id: string, ligado: boolean}[]} acessos @returns {{codigo: string}[]} */
function avisosDosAcessos(acessos) {
  const ligado = new Map(acessos.map((a) => [a.id, a.ligado === true]));
  if (!ligado.has(LEITURA) || ligado.get(LEITURA)) return [];
  const avisos = [];
  if (DEPENDENTES.some((id) => ligado.get(id) === true)) avisos.push({ codigo: FUNCIONARIOS_SEM_VISUALIZAR });
  if (ligado.get(EXPORTAR) === true) avisos.push({ codigo: EXPORTAR_HISTORICO_SEM_VISUALIZAR });
  return avisos;
}

module.exports = { avisosDosAcessos, FUNCIONARIOS_SEM_VISUALIZAR, EXPORTAR_HISTORICO_SEM_VISUALIZAR };
