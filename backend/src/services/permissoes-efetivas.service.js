'use strict';

const autorizacao = require('../middleware/autorizacao');
const autoridade = require('./autoridade-administrativa');
const delegacao = require('./delegacao-destinatarios.service');
const autorizacaoIndividual = require('./autorizacao-individual.service');
const permissaoRepo = require('../repositories/permissao.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const { RECURSOS_CONHECIDOS } = require('../rbac/recursos');

/**
 * Permissões EFETIVAS do usuário empresarial autenticado (Bloco 9, Etapa C,
 * Parte C1) — base de GET /api/auth/permissoes, somente leitura.
 *
 * NÃO É UMA SEGUNDA INTERPRETAÇÃO DO RBAC. Este módulo não decide nada:
 * ele pergunta, item a item, às MESMAS funções que o backend usa para
 * autorizar cada operação real, e devolve as respostas:
 *
 *   recursos       -> autorizacao.avaliarPermissaoRecurso: o corpo do
 *                     middleware criarExigirPermissaoRecurso (perfil ->
 *                     grupo principal, com a regra de grupo inativo ->
 *                     exceção individual; MASTER só pelo perfil).
 *   acoes          -> autorizacao.avaliarPermissaoAcao: o corpo do
 *                     middleware criarExigirPermissaoAcao (configuração
 *                     da ação, NENHUMA/ALTERNATIVA/OBRIGATORIA, SST,
 *                     bloqueio individual; MASTER pelo perfil).
 *   administracao  -> as regras PRÓPRIAS das páginas administrativas,
 *                     que não são permissões de recurso:
 *       gruposAcesso / permissoesGrupo / vinculosGrupo
 *                  -> autoridade.temAutoridadeAdministrativaLeitura:
 *                     MASTER ativo, ou ADMINISTRADOR ativo com autorização
 *                     individual efetiva para ADMINISTRAR_GRUPOS_ACESSO /
 *                     ADMINISTRAR_PERMISSOES_GRUPO / ADMINISTRAR_VINCULOS_GRUPO.
 *                     "consultar" e "alterar" usam o MESMO critério nos
 *                     serviços (a escrita só acrescenta FOR UPDATE), por
 *                     isso têm o mesmo valor aqui; são expostos em separado
 *                     para que a interface nunca presuma escrita a partir
 *                     de leitura.
 *       autorizacoesIndividuais
 *                  -> consultar: qualquer ator ativo (as próprias; o
 *                     MASTER vê todas — autorizacao-consulta.service.js);
 *                     concederDireta: autorizacaoIndividual.atorPodeConcederDireta
 *                     (só MASTER ativo); delegar: delegacao.atorPodeDelegar
 *                     (não-MASTER com ao menos uma origem própria efetiva).
 *
 * Empresa, usuário e perfil vêm SEMPRE da sessão validada (req.empresa /
 * req.usuario, relidos do banco pelo middleware de sessão a cada
 * requisição). Nada vem do navegador.
 *
 * O resultado é apresentação: a interface o usa para mostrar e esconder.
 * Cada operação real continua sendo autorizada pelo backend no momento em
 * que é feita — uma chamada direta a uma API proibida recebe 403 do mesmo
 * jeito.
 *
 * CUSTO: uma avaliação por recurso conhecido e por ação do catálogo, com
 * as mesmas leituras indexadas do middleware (dezenas de consultas curtas
 * por chamada). Aceitável para uma consulta por carregamento de página;
 * nada é guardado em cache no servidor, para que alterações de grupo,
 * perfil ou exceção valham na chamada seguinte.
 */

function exigirInteiroPositivo(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

/**
 * @param {{query: Function}} pool
 * @param {{empresaId: number, usuarioId: number, perfil: string}} contexto da sessão
 */
async function calcular(pool, { empresaId, usuarioId, perfil }) {
  exigirInteiroPositivo(empresaId, 'identificador de empresa');
  exigirInteiroPositivo(usuarioId, 'identificador de usuário');
  if (typeof perfil !== 'string' || perfil.length === 0) {
    throw new TypeError('perfil inválido');
  }
  const contexto = { empresaId, usuarioId, perfil };

  const recursos = {};
  for (const recurso of RECURSOS_CONHECIDOS) {
    // eslint-disable-next-line no-await-in-loop
    recursos[recurso] = await autorizacao.avaliarPermissaoRecurso(pool, contexto, recurso);
  }

  const acoes = {};
  const catalogo = await permissaoRepo.listarAcoes(pool);
  for (const acao of catalogo) {
    // eslint-disable-next-line no-await-in-loop
    acoes[acao.codigo] = await autorizacao.avaliarPermissaoAcao(pool, contexto, acao.codigo);
  }

  const { ACOES_ADMINISTRATIVAS } = autoridade;
  const gruposAcesso = await autoridade.temAutoridadeAdministrativaLeitura(pool, empresaId, usuarioId, ACOES_ADMINISTRATIVAS.GRUPOS_ACESSO);
  const permissoesGrupo = await autoridade.temAutoridadeAdministrativaLeitura(pool, empresaId, usuarioId, ACOES_ADMINISTRATIVAS.PERMISSOES_GRUPO);
  const vinculosGrupo = await autoridade.temAutoridadeAdministrativaLeitura(pool, empresaId, usuarioId, ACOES_ADMINISTRATIVAS.VINCULOS_GRUPO);

  const ator = await usuarioRepo.buscarPorId(pool, empresaId, usuarioId);
  const atorAtivo = ator !== null && ator.ativo === true;

  return {
    empresaId,
    usuarioId,
    perfil,
    recursos,
    acoes,
    administracao: {
      gruposAcesso: { consultar: gruposAcesso, alterar: gruposAcesso },
      permissoesGrupo: { consultar: permissoesGrupo, alterar: permissoesGrupo },
      vinculosGrupo: { consultar: vinculosGrupo, alterar: vinculosGrupo },
      autorizacoesIndividuais: {
        consultar: atorAtivo,
        concederDireta: autorizacaoIndividual.atorPodeConcederDireta(ator),
        delegar: await delegacao.atorPodeDelegar(pool, empresaId, usuarioId),
      },
    },
  };
}

module.exports = { calcular };
