'use strict';

const autorizacao = require('../middleware/autorizacao');
const loteRepo = require('../repositories/estoque-lote.repository');
const funcionarioRepo = require('../repositories/funcionario.repository');
const { DIAS_ALERTA_VALIDADE_CA } = require('../schemas/itens-disponiveis.schema');
const { exigirDataOperacional } = require('../utils/data-operacional');

/**
 * Indicadores do dashboard (Bloco 9, Etapa C, Parte C6) — somente leitura.
 *
 * A rota já exigiu `dashboard.visualizar`. Aqui, cada indicador só é
 * calculado e devolvido se o usuário também puder VISUALIZAR a fonte dos
 * dados, decidida pela MESMA função que autoriza as rotas
 * (autorizacao.avaliarPermissaoRecurso — nenhuma interpretação nova do RBAC):
 *   itensDisponiveis, estoqueAbaixoMinimo -> availableItems (os dados de
 *     Itens Disponíveis: disponível por material ativo × tamanho);
 *   caVencido (+ aVencer)               -> materials (lotes com saldo e CA
 *     vencido ou a vencer, na data operacional);
 *   funcionariosAtivos                  -> employeeHistory.
 * Sem a permissão da fonte: { permitido: false } — nenhum número sai do
 * servidor. Empresa, usuário e perfil vêm só da sessão.
 */

const FONTES = Object.freeze({ estoque: 'availableItems', catalogo: 'materials', funcionarios: 'employeeHistory' });
const NEGADO = Object.freeze({ permitido: false });

function exigirInteiroPositivo(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

async function podeVer(pool, contexto, recurso) {
  const decisao = await autorizacao.avaliarPermissaoRecurso(pool, contexto, recurso);
  return decisao.visualizar === true;
}

async function consultar(pool, { empresaId, usuarioId, perfil, hoje }) {
  exigirInteiroPositivo(empresaId, 'identificador de empresa');
  exigirDataOperacional(hoje);
  exigirInteiroPositivo(usuarioId, 'identificador de usuário');
  if (typeof perfil !== 'string' || perfil.length === 0) {
    throw new TypeError('perfil inválido');
  }
  const contexto = { empresaId, usuarioId, perfil };

  const [estoque, catalogo, funcionarios] = await Promise.all([
    podeVer(pool, contexto, FONTES.estoque),
    podeVer(pool, contexto, FONTES.catalogo),
    podeVer(pool, contexto, FONTES.funcionarios),
  ]);

  // Os indicadores de estoque saem da mesma consulta; só devolvo o que a fonte permite.
  const [resumo, ativos] = await Promise.all([
    estoque || catalogo ? loteRepo.resumirIndicadores(pool, empresaId, { hoje, diasAlerta: DIAS_ALERTA_VALIDADE_CA }) : null,
    funcionarios ? funcionarioRepo.contarPorEmpresa(pool, empresaId, { ativo: true }) : null,
  ]);

  return {
    itensDisponiveis: estoque ? { permitido: true, valor: resumo.disponivel } : { ...NEGADO },
    estoqueAbaixoMinimo: estoque ? { permitido: true, valor: resumo.abaixoMinimo } : { ...NEGADO },
    caVencido: catalogo
      ? { permitido: true, valor: resumo.caVencido, aVencer: resumo.caAVencer, diasAlerta: DIAS_ALERTA_VALIDADE_CA }
      : { ...NEGADO },
    funcionariosAtivos: funcionarios ? { permitido: true, valor: ativos } : { ...NEGADO },
  };
}

module.exports = { consultar, FONTES };
