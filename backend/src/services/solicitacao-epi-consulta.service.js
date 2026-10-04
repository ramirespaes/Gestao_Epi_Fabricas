'use strict';

const consultaRepo = require('../repositories/solicitacao-epi-consulta.repository');
const itemRepo = require('../repositories/solicitacao-epi-item.repository');
const coberturaRepo = require('../repositories/solicitacao-epi-cobertura.repository');
const { dataOperacional, exigirDataOperacional } = require('../utils/data-operacional');
const { situacaoDoItem, situacaoDaSolicitacao, quantidadesDaSolicitacao } = require('./solicitacao-epi-situacao');
const {
  linhaDaLista, itensSemEstoque, linhaEncerravel, trabalhadorDoDetalhe, pessoaDoDetalhe, materialDoDetalhe,
} = require('./solicitacao-epi-publica');
const solicitacaoSvc = require('./solicitacao-epi.service');
const autorizacao = require('../middleware/autorizacao');
const { HttpError } = require('../errors/HttpError');

/**
 * Listagens da solicitação de EPI (12E-1), só a camada de negócio, sem HTTP:
 * minhas solicitações, fila de decisão da SST e solicitações entregáveis.
 * Quem pode chamar cada uma é decidido pelas rotas (recurso `request`, ação
 * APROVAR_SOLICITACAO e ação REALIZAR_ENTREGA); aqui empresaId e atorId vêm da
 * sessão e nenhum filtro aceita identificador de empresa ou de usuário do
 * cliente. O detalhe (12F-1) não tem uma permissão única, então quem pode vê-lo
 * é decidido aqui, pelas mesmas avaliações da autorização central.
 *
 * Cada página sai de um retrato único do banco (REPEATABLE READ, somente
 * leitura): a página, o total, os itens e a cobertura. A situação operacional
 * e as quantidades são derivadas, nunca gravadas: a situação usa as mesmas
 * regras do detalhe, com a cobertura calculada contra a fila inteira dos pares
 * (não só contra a página) numa consulta única para todas as solicitações
 * aprovadas da página. A linha não leva CPF nem texto livre.
 *
 * 12G-0: as encerráveis (ação ENCERRAR_SOLICITACAO, na rota) são uma lista
 * própria e mínima, sem nada do estoque; o detalhe ganha os dados de
 * apresentação (trabalhador, material de cada item e os nomes de quem
 * solicitou, decidiu e encerrou), lidos só depois da autorização e do 404.
 */

const STATUS_COM_COBERTURA = Object.freeze(['APROVADA', 'APROVADA_PARCIAL']);
const { LIMITE_MAXIMO, STATUS } = consultaRepo;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirPaginacao(pagina, limite) {
  if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('página inválida');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
}

function exigirDataOpcional(hoje) {
  const data = hoje === undefined ? dataOperacional() : hoje;
  exigirDataOperacional(data);
  return data;
}

async function emLeitura(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erroLeitura) {
      await client.query('ROLLBACK');
      throw erroLeitura;
    }
  } finally {
    client.release();
  }
}

function agruparPorSolicitacao(itens) {
  const porSolicitacao = new Map();
  for (const item of itens) {
    if (!porSolicitacao.has(item.solicitacaoId)) porSolicitacao.set(item.solicitacaoId, []);
    porSolicitacao.get(item.solicitacaoId).push(item);
  }
  return porSolicitacao;
}

// A situação do item segue a do detalhe: só o aprovado conta entregue, e o item fora da fila de cobertura (trabalhador
// ou material inativo) tem `coberta` nula, o que o torna SUSPENSA sem mudar o status gravado.
const situacaoDe = (item, coberturaPorItem) => {
  const cobertura = coberturaPorItem.get(item.id) ?? null;
  return situacaoDoItem({
    decisao: item.decisao,
    quantidadeAprovada: item.quantidadeAprovada,
    quantidadeEntregue: item.decisao === 'APROVADO' ? item.quantidadeEntregue : 0,
    coberta: cobertura === null ? null : cobertura.coberta,
  });
};

async function montarLinhas(client, empresaId, linhas, hoje, { comEncerramento = false } = {}) {
  if (linhas.length === 0) return [];
  const itensPorSolicitacao = agruparPorSolicitacao(
    await itemRepo.listarPorSolicitacoesComEntregue(client, empresaId, linhas.map((l) => l.id)),
  );
  const comCobertura = linhas.filter((l) => STATUS_COM_COBERTURA.includes(l.status)).map((l) => l.id);
  const cobertura = comCobertura.length === 0
    ? []
    : await coberturaRepo.listarCoberturaDasSolicitacoes(client, empresaId, { hoje, solicitacaoIds: comCobertura });
  const coberturaPorItem = new Map(cobertura.map((c) => [c.itemId, c]));

  return linhas.map((linha) => {
    const itens = itensPorSolicitacao.get(linha.id) ?? [];
    return linhaDaLista(linha, {
      situacaoOperacional: situacaoDaSolicitacao(linha.status, itens.map((i) => situacaoDe(i, coberturaPorItem))),
      quantidades: quantidadesDaSolicitacao(linha.status, itens),
      comEncerramento,
    });
  });
}

/**
 * As solicitações criadas pelo próprio usuário (solicitante interno), em todas
 * as situações, das mais recentes para as antigas; `status` opcional.
 */
async function listarMinhas(pool, {
  empresaId, atorId, status = null, pagina, limite, hoje,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  if (status !== null && !STATUS.includes(status)) throw new TypeError('status inválido');
  exigirPaginacao(pagina, limite);
  const dataOperacionalAtual = exigirDataOpcional(hoje);

  return emLeitura(pool, async (client) => {
    const linhas = await consultaRepo.listarMinhas(client, empresaId, atorId, { status, pagina, limite });
    const total = await consultaRepo.contarMinhas(client, empresaId, atorId, { status });
    const solicitacoes = await montarLinhas(client, empresaId, linhas, dataOperacionalAtual, { comEncerramento: true });
    return {
      solicitacoes, total, pagina, limite,
    };
  });
}

/** A fila de decisão da SST: as PENDENTE da empresa, da mais antiga para a mais nova. */
async function listarFila(pool, { empresaId, pagina, limite }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirPaginacao(pagina, limite);

  return emLeitura(pool, async (client) => {
    const linhas = await consultaRepo.listarFila(client, empresaId, { pagina, limite });
    const total = await consultaRepo.contarFila(client, empresaId);
    return { solicitacoes: await montarLinhas(client, empresaId, linhas, undefined), total, pagina, limite };
  });
}

/**
 * As solicitações aprovadas (APROVADA e APROVADA_PARCIAL) que ainda podem ser
 * entregues, na ordem da fila de cobertura, com as quantidades aprovada,
 * entregue e restante; a suspensa por trabalhador ou material inativo continua
 * na lista como SUSPENSA. `funcionarioId` opcional filtra por trabalhador.
 */
async function listarEntregaveis(pool, {
  empresaId, funcionarioId = null, pagina, limite, hoje,
}) {
  exigirId(empresaId, 'identificador de empresa');
  if (funcionarioId !== null) exigirId(funcionarioId, 'identificador de funcionário');
  exigirPaginacao(pagina, limite);
  const dataOperacionalAtual = exigirDataOpcional(hoje);

  return emLeitura(pool, async (client) => {
    const linhas = await consultaRepo.listarEntregaveis(client, empresaId, { funcionarioId, pagina, limite });
    const total = await consultaRepo.contarEntregaveis(client, empresaId, { funcionarioId });
    return { solicitacoes: await montarLinhas(client, empresaId, linhas, dataOperacionalAtual), total, pagina, limite };
  });
}

// Quem tem alguma destas ações trabalha a solicitação (decide, encerra ou entrega) e vê qualquer uma da empresa.
const ACOES_DO_DETALHE = Object.freeze(['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO', 'REALIZAR_ENTREGA']);
const RECURSO_SOLICITACAO = 'request';

async function temAutoridadeFuncional(pool, contexto) {
  for (const acao of ACOES_DO_DETALHE) {
    if (await autorizacao.avaliarPermissaoAcao(pool, contexto, acao)) return true;
  }
  return false;
}

/**
 * Detalhe de uma solicitação (12F-1). Quem trabalha a solicitação (uma das
 * ACOES_DO_DETALHE, pela autorização central) vê qualquer uma da empresa,
 * com a cobertura e a posição do estoque de cada item. Quem só tem o recurso
 * `request` vê só as próprias e sem os números do estoque, que pertencem a
 * quem decide ou entrega. Sem nenhuma das duas autoridades, o mesmo 403
 * genérico do middleware, antes de ler a solicitação. A de outro solicitante,
 * a de outra empresa e a inexistente são o mesmo 404. As quantidades da
 * solicitação são as mesmas das listas, derivadas dos itens.
 *
 * @throws {HttpError} 403 sem autoridade; 404 solicitação não encontrada
 */
async function buscarDetalhe(pool, {
  empresaId, usuarioId, perfil, solicitacaoId, hoje,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  if (typeof perfil !== 'string' || perfil.length === 0) throw new TypeError('perfil inválido');
  exigirId(solicitacaoId, 'identificador de solicitação');
  const dataOperacionalAtual = exigirDataOpcional(hoje);

  const contexto = { empresaId, usuarioId, perfil };
  const funcional = await temAutoridadeFuncional(pool, contexto);
  if (!funcional) {
    const recurso = await autorizacao.avaliarPermissaoRecurso(pool, contexto, RECURSO_SOLICITACAO);
    if (recurso.visualizar !== true) throw HttpError.forbidden('PERMISSAO_NEGADA', autorizacao.MENSAGEM_PERMISSAO_NEGADA);
  }

  const visao = await solicitacaoSvc.buscarSolicitacao(pool, {
    empresaId, solicitacaoId, hoje: dataOperacionalAtual, solicitanteUsuarioId: funcional ? null : usuarioId,
  });
  // Só depois da autorização e do 404: o que não pode ser visto nunca chega a ser lido para apresentação.
  const s = visao.solicitacao;
  const apresentacao = await emLeitura(pool, (client) => consultaRepo.dadosDeApresentacao(client, empresaId, {
    funcionarioId: s.funcionarioId,
    materialIds: [...new Set(visao.itens.map((i) => i.materialId))],
    usuarioIds: [...new Set([s.solicitanteUsuarioId, s.decisao?.decididaPor, s.encerramento?.encerradaPor].filter((id) => Number.isInteger(id)))],
  }));
  const usuarios = new Map(apresentacao.usuarios.map((u) => [u.id, u]));
  const materiais = new Map(apresentacao.materiais.map((m) => [m.id, m]));
  return {
    solicitacao: {
      ...s,
      quantidades: quantidadesDaSolicitacao(s.status, visao.itens),
      funcionario: trabalhadorDoDetalhe(apresentacao.funcionario),
      solicitante: pessoaDoDetalhe(usuarios.get(s.solicitanteUsuarioId)),
      decisao: s.decisao === null ? null : { ...s.decisao, decisor: pessoaDoDetalhe(usuarios.get(s.decisao.decididaPor)) },
      encerramento: s.encerramento === null ? null : { ...s.encerramento, encerrador: pessoaDoDetalhe(usuarios.get(s.encerramento.encerradaPor)) },
    },
    itens: (funcional ? visao.itens : itensSemEstoque(visao.itens)).map((i) => ({ ...i, material: materialDoDetalhe(materiais.get(i.materialId)) })),
  };
}

/**
 * As solicitações que quem encerra pode encerrar (12G-0, L4): APROVADA e
 * APROVADA_PARCIAL da empresa, inclusive a suspensa por trabalhador ou material
 * inativo, na ordem da aprovação. Só o necessário para localizar: sem situação
 * derivada do estoque, cobertura, posição, lote ou saldo; as quantidades são as
 * da própria solicitação (aprovada, entregue e restante). `funcionarioId`
 * opcional filtra por trabalhador.
 */
async function listarEncerraveis(pool, {
  empresaId, funcionarioId = null, pagina, limite,
}) {
  exigirId(empresaId, 'identificador de empresa');
  if (funcionarioId !== null) exigirId(funcionarioId, 'identificador de funcionário');
  exigirPaginacao(pagina, limite);

  return emLeitura(pool, async (client) => {
    const linhas = await consultaRepo.listarEncerraveis(client, empresaId, { funcionarioId, pagina, limite });
    const total = await consultaRepo.contarEncerraveis(client, empresaId, { funcionarioId });
    const itensPorSolicitacao = linhas.length === 0
      ? new Map()
      : agruparPorSolicitacao(await itemRepo.listarPorSolicitacoesComEntregue(client, empresaId, linhas.map((l) => l.id)));
    const solicitacoes = linhas.map((l) => linhaEncerravel(l, { quantidades: quantidadesDaSolicitacao(l.status, itensPorSolicitacao.get(l.id) ?? []) }));
    return {
      solicitacoes, total, pagina, limite,
    };
  });
}

module.exports = {
  listarMinhas, listarFila, listarEntregaveis, listarEncerraveis, buscarDetalhe,
};
