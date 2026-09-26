'use strict';

const autorizacao = require('../middleware/autorizacao');
const estoqueTamanhoRepo = require('../repositories/estoque-tamanho.repository');
const materialRepo = require('../repositories/material.repository');
const funcionarioRepo = require('../repositories/funcionario.repository');
const { DIAS_ALERTA_VALIDADE_CA } = require('../schemas/itens-disponiveis.schema');

/**
 * Indicadores do dashboard (Bloco 9, Etapa C, Parte C6) — somente leitura.
 *
 * A rota já exigiu `dashboard.visualizar`. Aqui, cada indicador só é
 * calculado e devolvido se o usuário também puder VISUALIZAR a fonte dos
 * dados, decidida pela MESMA função que autoriza as rotas
 * (autorizacao.avaliarPermissaoRecurso — nenhuma interpretação nova do RBAC):
 *   itensDisponiveis, estoqueAbaixoMinimo -> availableItems (os dados de
 *     Itens Disponíveis, C3: saldo por material ativo × tamanho);
 *   caVencido (+ aVencer)               -> materials (validade do CA é
 *     atributo do cadastro do material);
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

async function consultar(pool, { empresaId, usuarioId, perfil }) {
  exigirInteiroPositivo(empresaId, 'identificador de empresa');
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

  const [resumo, validade, ativos] = await Promise.all([
    estoque ? estoqueTamanhoRepo.resumirDisponiveis(pool, empresaId) : null,
    catalogo ? materialRepo.contarValidadeCa(pool, empresaId, DIAS_ALERTA_VALIDADE_CA) : null,
    funcionarios ? funcionarioRepo.contarPorEmpresa(pool, empresaId, { ativo: true }) : null,
  ]);

  return {
    itensDisponiveis: estoque ? { permitido: true, valor: resumo.disponivel } : { ...NEGADO },
    estoqueAbaixoMinimo: estoque ? { permitido: true, valor: resumo.abaixoMinimo } : { ...NEGADO },
    caVencido: catalogo
      ? { permitido: true, valor: validade.vencido, aVencer: validade.aVencer, diasAlerta: DIAS_ALERTA_VALIDADE_CA }
      : { ...NEGADO },
    funcionariosAtivos: funcionarios ? { permitido: true, valor: ativos } : { ...NEGADO },
  };
}

module.exports = { consultar, FONTES };
