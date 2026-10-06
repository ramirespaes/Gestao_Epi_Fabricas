'use strict';

const autorizacaoRepo = require('../repositories/autorizacao-individual.repository');
const permissaoIndividualRepo = require('../repositories/permissao-individual.repository');
const permissaoRepo = require('../repositories/permissao.repository');
const autorizacaoIndividual = require('./autorizacao-individual.service');

/**
 * Cópia da CONFIGURAÇÃO DE ACESSO INDIVIDUAL de um usuário (origem) para outro
 * (destino), na MESMA transação de quem chama (duplicar usuário e copiar
 * permissões). Copia só as camadas individuais: exceções de recurso, bloqueios
 * de ação e concessões DIRETAS de ação. Nunca copia nome, CPF, matrícula,
 * e-mail, setor, horário, IP, senha, identidade nem perfil; o grupo é decidido
 * por quem chama (cada fluxo tem a sua regra).
 *
 * AUTORIDADE: as camadas individuais só são gravadas por MASTER (é o que a 3I
 * já exige para conceder direto); o MASTER é o único que pode copiá-las, e
 * ninguém ganha com a cópia o que não poderia conceder. Para ator não MASTER, a
 * cópia individual não acontece (`executado: false`) e o chamador informa isso.
 * Destino MASTER nunca recebe camada individual (autoridade própria, fixa).
 *
 * As concessões reutilizam autorizacao-individual.service (concederDireta e
 * revogar), que conferem ator MASTER, beneficiário ativo e da empresa, ação
 * ativa e com modo diferente de NENHUMA, e auditam cada ato. Elas abrem a
 * própria "transação"; aqui isso é adaptado para a transação externa (BEGIN,
 * COMMIT e ROLLBACK viram no-ops; qualquer exceção desfaz tudo na de fora).
 */

const PERFIL_MASTER = 'MASTER';
const COMANDO_DE_TRANSACAO = /^\s*(BEGIN|COMMIT|ROLLBACK)\s*$/i;

/** Pool de mentira que entrega sempre a mesma conexão e ignora o controle de transação. */
function poolSobre(client) {
  return {
    connect: async () => ({
      query: (texto, parametros) => (COMANDO_DE_TRANSACAO.test(String(texto))
        ? Promise.resolve({ rows: [], rowCount: 0 })
        : client.query(texto, parametros)),
      release() {},
    }),
  };
}

const VAZIO = Object.freeze({
  executado: false, motivo: null, recursos: 0, bloqueios: 0, autorizacoes: 0, ignoradas: 0,
});

async function acaoConcedivel(client, acaoCodigo) {
  const c = await permissaoRepo.buscarConfiguracaoAcao(client, acaoCodigo);
  return c !== null && c.ativo === true && ['ALTERNATIVA', 'OBRIGATORIA'].includes(c.modoAutorizacaoIndividual) && typeof c.exigeSst === 'boolean';
}

/**
 * @returns {Promise<{executado: boolean, motivo: string|null, recursos: number, bloqueios: number, autorizacoes: number, ignoradas: number}>}
 */
async function copiarAcessoIndividual(client, {
  empresaId, ator, origemId, destinoId, destinoPerfil, destinoAtivo = true, ip = null, dispositivo = null,
}) {
  if (ator.perfil !== PERFIL_MASTER) {
    return { ...VAZIO, motivo: 'SOMENTE_MASTER' };
  }
  if (destinoPerfil === PERFIL_MASTER) {
    return { ...VAZIO, motivo: 'DESTINO_MASTER' };
  }
  const recursos = await permissaoIndividualRepo.copiarRecursos(client, {
    empresaId, origemId, destinoId, concedidoPor: ator.id,
  });
  const bloqueios = await permissaoIndividualRepo.copiarBloqueios(client, {
    empresaId, origemId, destinoId, bloqueadoPor: ator.id,
  });

  const diretas = (usuarioId) => autorizacaoRepo.listarPorUsuario(client, empresaId, usuarioId)
    .then((linhas) => linhas.filter((l) => l.origemId === null));
  const daOrigem = await diretas(origemId);
  const doDestino = await diretas(destinoId);
  const codigosOrigem = new Set(daOrigem.map((l) => l.acaoCodigo));
  const pool = poolSobre(client);
  let autorizacoes = 0;
  let ignoradas = 0;

  for (const extra of doDestino.filter((l) => !codigosOrigem.has(l.acaoCodigo))) {
    await autorizacaoIndividual.revogar(pool, {
      empresaId, revogadoPor: ator.id, autorizacaoId: extra.id, motivo: null, ip, dispositivo,
    });
  }
  const jaNoDestino = new Set(doDestino.map((l) => l.acaoCodigo));
  for (const linha of daOrigem) {
    if (jaNoDestino.has(linha.acaoCodigo)) {
      autorizacoes += 1;
    } else if (destinoAtivo && destinoId !== ator.id && await acaoConcedivel(client, linha.acaoCodigo)) {
      await autorizacaoIndividual.concederDireta(pool, {
        empresaId, concedidoPor: ator.id, usuarioId: destinoId, acaoCodigo: linha.acaoCodigo, podeDelegar: linha.podeDelegar, motivo: null, ip, dispositivo,
      });
      autorizacoes += 1;
    } else {
      ignoradas += 1;
    }
  }

  return {
    executado: true, motivo: null, recursos, bloqueios, autorizacoes, ignoradas,
  };
}

module.exports = { copiarAcessoIndividual, poolSobre, PERFIL_MASTER };
