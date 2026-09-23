'use strict';

const autorizacaoIndividualService = require('../services/autorizacao-individual.service');
const { pool } = require('../config/database');

/**
 * Controller de autorizações individuais de ação (Bloco 8, Incremento
 * 8, Etapa 5A, Subetapa 3P).
 *
 * Traduz requisição em chamada de serviço e resultado em resposta HTTP.
 * Não decide NADA: autoridade para conceder (só MASTER) ou delegar (só
 * não-MASTER, a partir de origem própria com pode_delegar = true),
 * validade da origem, modo da ação, exigência de SST e auditoria já
 * estão resolvidos em autorizacao-individual.service.js, aprovado na
 * Subetapa 3I e inalterado em suas três operações. Sem try/catch:
 * Express 5 encaminha a Promise rejeitada ao errorHandler.
 *
 * `autorizacaoIndividualService.funcao(...)` é chamado por namespace,
 * nunca desestruturado — mesma razão dos demais controllers deste
 * bloco.
 *
 * FONTE DE AUTORIDADE: `empresaId` e o id de quem age (`concedidoPor`/
 * `revogadoPor`) saem EXCLUSIVAMENTE de req.empresa.id e req.usuario.id.
 * Nada vindo do corpo influencia quem é o ator ou de qual empresa ele
 * é — um `empresaId`, `concedidoPor`, `autorizadoPor`, `isMaster` ou
 * `perfil` enviados no corpo sequer passam pelo schema (strictObject os
 * rejeita), e mesmo que passassem não seriam lidos aqui.
 *
 * ESCOLHA ENTRE concederDireta E delegar: decidida só pelo campo `tipo`
 * já validado pelo schema (z.discriminatedUnion) — uma ramificação de
 * roteamento, não uma regra de negócio. Qual das duas é permitida para
 * quem chama continua sendo decisão exclusiva do serviço.
 *
 * CAMPOS OPCIONAIS REPASSADOS SÓ QUANDO INFORMADOS: `podeDelegar` e
 * `motivo` só entram no objeto passado ao serviço quando a chave
 * realmente veio no corpo validado (`Object.hasOwn`) — para que
 * "ausente" continue significando "deixe o serviço aplicar o próprio
 * padrão" (podeDelegar=false, motivo=null), nunca um valor imposto
 * por este controller.
 *
 * O pool real de config/database.js entra pela fábrica, nunca importado
 * por service ou repository — mesma decisão arquitetural do Bloco 8.
 */

function criarAutorizacaoIndividualController({ pool: poolInjetado }) {
  return {
    async criar(req, res) {
      const corpo = req.validado.body;
      const comuns = {
        empresaId: req.empresa.id,
        concedidoPor: req.usuario.id,
        usuarioId: corpo.usuarioId,
        ...(Object.hasOwn(corpo, 'podeDelegar') ? { podeDelegar: corpo.podeDelegar } : {}),
        ...(Object.hasOwn(corpo, 'motivo') ? { motivo: corpo.motivo } : {}),
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      };

      const autorizacao = corpo.tipo === 'DIRETA'
        ? await autorizacaoIndividualService.concederDireta(poolInjetado, { ...comuns, acaoCodigo: corpo.acaoCodigo })
        : await autorizacaoIndividualService.delegar(poolInjetado, { ...comuns, origemId: corpo.origemId });

      res.status(201).json({ status: 'ok', autorizacao });
    },

    /**
     * Revoga uma autorização específica pelo id. Cobre também a
     * "revogação por origem" prevista na Subetapa 3I: revogar uma
     * autorização que é origem de outras aciona a cascata (FK ON
     * DELETE CASCADE da migration 023) sobre seus descendentes — não
     * existe nem é preciso um endpoint separado para isso.
     */
    async revogar(req, res) {
      const corpo = req.validado.body;
      const resultado = await autorizacaoIndividualService.revogar(poolInjetado, {
        empresaId: req.empresa.id,
        revogadoPor: req.usuario.id,
        autorizacaoId: req.validado.params.id,
        ...(Object.hasOwn(corpo, 'motivo') ? { motivo: corpo.motivo } : {}),
        ip: req.ip,
        dispositivo: req.headers['user-agent'],
      });

      res.status(200).json({ status: 'ok', revogada: resultado.revogada, descendentesObservados: resultado.descendentesObservados });
    },
  };
}

const autorizacaoIndividualController = criarAutorizacaoIndividualController({ pool });

module.exports = { criarAutorizacaoIndividualController, autorizacaoIndividualController };
