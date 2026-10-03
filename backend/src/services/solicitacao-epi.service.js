'use strict';

const { HttpError } = require('../errors/HttpError');
const funcionarioRepo = require('../repositories/funcionario.repository');
const materialRepo = require('../repositories/material.repository');
const gheRepo = require('../repositories/grupo-homogeneo-exposicao.repository');
const gheMaterialRepo = require('../repositories/ghe-material.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const solicitacaoRepo = require('../repositories/solicitacao-epi.repository');
const itemRepo = require('../repositories/solicitacao-epi-item.repository');
const numeracaoRepo = require('../repositories/solicitacao-epi-numeracao.repository');
const coberturaRepo = require('../repositories/solicitacao-epi-cobertura.repository');
const parRepo = require('../repositories/estoque-par.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const idempotencia = require('../utils/idempotencia');
const { parOrdenados } = require('../utils/lock-par-estoque');
const { dataOperacional, exigirDataOperacional } = require('../utils/data-operacional');
const { situacaoDoItem, situacaoDaSolicitacao } = require('./solicitacao-epi-situacao');
const { solicitacaoPublica, itemPublico } = require('./solicitacao-epi-publica');

/**
 * Solicitação de EPI (12B): criação, decisão da Segurança do Trabalho,
 * cancelamento e consulta. Só a camada de negócio, sem HTTP. A autorização
 * de quem pode criar, decidir ou cancelar é das rotas, quando existirem
 * (recurso `request`, ações APROVAR_SOLICITACAO e REPROVAR_SOLICITACAO); aqui
 * ficam as regras que não dependem do middleware: separação de funções,
 * trabalhador e material ativos, justificativas e o estado da solicitação.
 * empresaId e atorId vêm da sessão. A solicitação não reserva nem baixa
 * estoque: a reserva é lógica e derivada (posição por empresa, material e
 * tamanho), e a aprovação não exige saldo.
 *
 * Ordem global das travas, para não formar ciclo com entrega, entrada e
 * baixa: chave de idempotência → solicitação → trabalhador (FOR NO KEY
 * UPDATE) → materiais (FOR SHARE, ids crescentes) → pares material+tamanho
 * (advisory, ordem canônica) → lotes → contador da numeração. A decisão que
 * aprova trava os pares dos itens aprovados antes de gravar.
 */

const LIMITE_ITENS = 20;
const LIMITE_INTEGER_POSTGRES = 2147483647;
const TAMANHO_MAXIMO = 20;
const OBSERVACAO_MAXIMA = 500;
const { MOTIVOS } = itemRepo;
const DECISOES = itemRepo.DECISOES;
const JUSTIFICATIVA_MAXIMA = 500;
const STATUS_COM_COBERTURA = Object.freeze(['APROVADA', 'APROVADA_PARCIAL']);
const ACAO_CRIADA = 'SOLICITACAO_EPI_CRIADA';
const ACAO_DECIDIDA = 'SOLICITACAO_EPI_DECIDIDA';
const ACAO_CANCELADA = 'SOLICITACAO_EPI_CANCELADA';
const CARACTERE_CONTROLE = /\p{Cc}/u;
const MSG_FORMATO_INVALIDO = 'Formato inválido';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

const inteiroPositivo = (valor) => Number.isInteger(valor) && valor > 0;

// Mesmo formato do 400 da validação da rota: campo, código e mensagem, sem o valor recebido.
function recusar(campo, codigo, mensagem) {
  return HttpError.validacao([{ campo: `body.${campo}`, codigo, mensagem }]);
}

async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erroTransacional) {
      await client.query('ROLLBACK');
      throw erroTransacional;
    }
  } finally {
    client.release();
  }
}

// Leitura consistente: um só retrato do banco para a solicitação, os itens e a cobertura.
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

function textoCanonico(valor, maximo) {
  if (typeof valor !== 'string') return null;
  const texto = valor.trim().normalize('NFC');
  const tamanho = Array.from(texto).length;
  return tamanho === 0 || tamanho > maximo || CARACTERE_CONTROLE.test(texto) ? null : texto;
}

function justificativaOpcional(valor, campo) {
  if (valor === null || valor === undefined) return null;
  const texto = textoCanonico(valor, JUSTIFICATIVA_MAXIMA);
  if (texto === null) throw recusar(campo, 'JUSTIFICATIVA_INVALIDA', 'Justificativa inválida');
  return texto;
}

function observacaoOpcional(valor) {
  if (valor === null || valor === undefined) return null;
  const texto = textoCanonico(valor, OBSERVACAO_MAXIMA);
  if (texto === null) throw recusar('observacao', 'OBSERVACAO_INVALIDA', 'Observação inválida');
  return texto;
}

const compararItens = (a, b) => {
  if (a.materialId !== b.materialId) return a.materialId - b.materialId;
  const ta = a.tamanho ?? '';
  const tb = b.tamanho ?? '';
  if (ta === tb) return 0;
  return ta < tb ? -1 : 1;
};

function validarItens(itens) {
  if (!Array.isArray(itens) || itens.length < 1 || itens.length > LIMITE_ITENS) {
    throw recusar('itens', 'ITENS_FORA_DO_LIMITE', `A solicitação precisa ter de 1 a ${LIMITE_ITENS} itens`);
  }
  const vistos = new Set();
  const normalizados = itens.map((item, i) => {
    const campo = `itens[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw recusar(campo, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    if (!inteiroPositivo(item.materialId)) throw recusar(`${campo}.materialId`, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    if (!inteiroPositivo(item.quantidade) || item.quantidade > LIMITE_INTEGER_POSTGRES) {
      throw recusar(`${campo}.quantidade`, 'QUANTIDADE_INVALIDA', 'Quantidade inválida');
    }
    if (!MOTIVOS.includes(item.motivo)) throw recusar(`${campo}.motivo`, 'VALOR_NAO_PERMITIDO', 'Valor não permitido');
    const semTamanho = item.tamanho === null || item.tamanho === undefined;
    const tamanho = semTamanho ? null : textoCanonico(item.tamanho, TAMANHO_MAXIMO);
    if (!semTamanho && tamanho === null) throw recusar(`${campo}.tamanho`, 'TAMANHO_INVALIDO', 'Tamanho inválido');
    const justificativa = justificativaOpcional(item.justificativa, `${campo}.justificativa`);
    if (item.motivo === 'OUTRO' && justificativa === null) {
      throw recusar(`${campo}.justificativa`, 'JUSTIFICATIVA_OBRIGATORIA', 'Justificativa obrigatória para o motivo OUTRO');
    }
    const chave = `${item.materialId}\n${tamanho ?? ''}`;
    if (vistos.has(chave)) throw recusar('itens', 'ITEM_REPETIDO', 'Cada material e tamanho aparece uma vez só na solicitação');
    vistos.add(chave);
    return {
      indice: i, materialId: item.materialId, tamanho, quantidade: item.quantidade, motivo: item.motivo, justificativa,
    };
  });
  // Ordem canônica: a mesma solicitação lógica vira a mesma requisição, qualquer que seja a ordem recebida.
  return normalizados.sort(compararItens);
}

/**
 * Hash da requisição lógica: solicitante, trabalhador, observação e itens em
 * ordem canônica. Chave, IP, dispositivo e tudo que o servidor gera ficam de
 * fora. O solicitante entra para que outra pessoa não reaproveite a chave e
 * receba a solicitação alheia.
 */
function hashDaRequisicao({
  atorId, funcionarioId, observacao, itens,
}) {
  const canonicos = [...itens]
    .sort(compararItens)
    .map((i) => [i.materialId, i.tamanho ?? null, i.quantidade, i.motivo, i.justificativa ?? null]);
  return idempotencia.hashRequisicao(['SOLICITACAO', atorId, funcionarioId, observacao ?? null, canonicos]);
}

function validarDecisoes(decisoes) {
  if (!Array.isArray(decisoes) || decisoes.length < 1 || decisoes.length > LIMITE_ITENS) {
    throw recusar('decisoes', 'ITENS_FORA_DO_LIMITE', `A decisão precisa cobrir de 1 a ${LIMITE_ITENS} itens`);
  }
  const vistos = new Set();
  return decisoes.map((x, i) => {
    const campo = `decisoes[${i}]`;
    if (x === null || typeof x !== 'object' || Array.isArray(x)) throw recusar(campo, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    if (!inteiroPositivo(x.itemId)) throw recusar(`${campo}.itemId`, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    if (vistos.has(x.itemId)) throw recusar('decisoes', 'DECISAO_REPETIDA', 'Cada item recebe uma decisão só');
    vistos.add(x.itemId);
    if (!DECISOES.includes(x.decisao)) throw recusar(`${campo}.decisao`, 'VALOR_NAO_PERMITIDO', 'Valor não permitido');

    const semQuantidade = x.quantidadeAprovada === null || x.quantidadeAprovada === undefined;
    let quantidadeAprovada = null;
    if (x.decisao === 'APROVADO') {
      if (!semQuantidade) {
        if (!inteiroPositivo(x.quantidadeAprovada) || x.quantidadeAprovada > LIMITE_INTEGER_POSTGRES) {
          throw recusar(`${campo}.quantidadeAprovada`, 'QUANTIDADE_INVALIDA', 'Quantidade inválida');
        }
        quantidadeAprovada = x.quantidadeAprovada;
      }
    } else if (!semQuantidade && x.quantidadeAprovada !== 0) {
      throw recusar(`${campo}.quantidadeAprovada`, 'QUANTIDADE_INVALIDA', 'Quantidade inválida');
    }
    const justificativa = justificativaOpcional(x.justificativa, `${campo}.justificativa`);
    if (x.decisao === 'REPROVADO' && justificativa === null) {
      throw recusar(`${campo}.justificativa`, 'JUSTIFICATIVA_OBRIGATORIA', 'Justificativa obrigatória para o item reprovado');
    }
    return {
      indice: i, itemId: x.itemId, decisao: x.decisao, quantidadeAprovada, justificativa,
    };
  });
}

function exigirDataOpcional(hoje) {
  const data = hoje === undefined ? dataOperacional() : hoje;
  exigirDataOperacional(data);
  return data;
}

async function exigirAtorAtivo(client, empresaId, atorId) {
  const ator = await usuarioRepo.buscarPorId(client, empresaId, atorId);
  if (ator === null) throw HttpError.notFound('USUARIO_NAO_ENCONTRADO', 'Usuário não encontrado');
  if (ator.ativo !== true) throw HttpError.forbidden('USUARIO_INATIVO', 'Usuário inativo');
  return ator;
}

const chaveDoPar = (materialId, tamanho) => `${materialId}\n${tamanho ?? ''}`;

/**
 * Solicitação, itens e a situação operacional derivada, como a tela os vê. A
 * cobertura e a posição só existem para solicitação com aprovação ativa e
 * saem do estoque de agora na data operacional recebida: nada é gravado.
 */
async function visaoDaSolicitacao(executor, empresaId, solicitacao, hoje) {
  const itens = await itemRepo.listarPorSolicitacaoComEntregue(executor, empresaId, solicitacao.id);
  const comCobertura = STATUS_COM_COBERTURA.includes(solicitacao.status);
  let coberturaPorItem = new Map();
  let posicaoPorPar = new Map();
  if (comCobertura) {
    const cobertura = await coberturaRepo.listarCobertura(executor, empresaId, { hoje, solicitacaoId: solicitacao.id });
    coberturaPorItem = new Map(cobertura.map((c) => [c.itemId, c]));
    const pares = itens.filter((i) => i.decisao === 'APROVADO').map((i) => ({ materialId: i.materialId, tamanho: i.tamanho }));
    const posicoes = await coberturaRepo.lerPosicoes(executor, empresaId, pares, { hoje });
    posicaoPorPar = new Map(posicoes.map((p) => [chaveDoPar(p.materialId, p.tamanho), p]));
  }

  const itensPublicos = itens.map((i) => {
    const aprovado = i.decisao === 'APROVADO';
    // Derivada das entregas ligadas ao item; só o item aprovado recebe entrega.
    const quantidadeEntregue = aprovado ? i.quantidadeEntregue : 0;
    const linha = coberturaPorItem.get(i.id) ?? null;
    const posicao = comCobertura && aprovado ? posicaoPorPar.get(chaveDoPar(i.materialId, i.tamanho)) ?? null : null;
    return {
      situacao: situacaoDoItem({
        decisao: i.decisao, quantidadeAprovada: i.quantidadeAprovada, quantidadeEntregue, coberta: linha === null ? null : linha.coberta,
      }),
      item: i,
      quantidadeEntregue,
      cobertura: linha === null
        ? null
        : {
          coberta: linha.coberta, semCobertura: linha.semCobertura, acumuladoAnterior: linha.acumuladoAnterior, fisicoUtilizavel: linha.fisicoUtilizavel,
        },
      posicao: posicao === null
        ? null
        : {
          fisicoUtilizavel: posicao.fisicoUtilizavel,
          demandaPendente: posicao.demandaPendente,
          comprometido: posicao.comprometido,
          saldoLivre: posicao.saldoLivre,
          semCobertura: posicao.semCobertura,
        },
    };
  });
  const situacaoOperacional = situacaoDaSolicitacao(solicitacao.status, itensPublicos.map((x) => x.situacao));
  return {
    solicitacao: solicitacaoPublica(solicitacao, situacaoOperacional),
    itens: itensPublicos.map(({ item, ...derivados }) => itemPublico(item, derivados)),
  };
}

// Consulto a chave antes de qualquer regra: se a solicitação já foi criada, a
// repetição recebe o resultado original. A trava vale até o fim da transação.
async function repetirSeJaCriada(client, empresaId, chave, requisicaoHash) {
  await solicitacaoRepo.travarChave(client, empresaId, chave);
  const existente = await solicitacaoRepo.buscarPorChave(client, empresaId, chave);
  if (existente === null) return null;
  if (existente.requisicaoHash !== requisicaoHash) {
    throw HttpError.conflict('IDEMPOTENCIA_CONFLITO', 'Esta chave de idempotência já foi usada em outra solicitação');
  }
  return { repetida: true, ...await visaoDaSolicitacao(client, empresaId, existente, dataOperacional()) };
}

function validarMateriaisDaSolicitacao(materiais, idsPedidos) {
  const porId = new Map(materiais.map((m) => [m.id, m]));
  for (const id of idsPedidos) {
    const material = porId.get(id);
    if (material === undefined) throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', 'Material não encontrado');
    if (material.ativo !== true) throw HttpError.conflict('MATERIAL_INATIVO', 'Material inativo não pode ser solicitado');
    if (material.exigeTamanho === null) {
      throw HttpError.conflict('MATERIAL_TAMANHO_NAO_CLASSIFICADO', 'Defina no cadastro se o material exige tamanho antes de solicitá-lo');
    }
  }
  return porId;
}

function validarTamanhos(itens, materiais) {
  for (const item of itens) {
    const exige = materiais.get(item.materialId).exigeTamanho;
    if (exige && item.tamanho === null) {
      throw recusar(`itens[${item.indice}].tamanho`, 'TAMANHO_OBRIGATORIO', 'Este material exige tamanho');
    }
    if (!exige && item.tamanho !== null) {
      throw recusar(`itens[${item.indice}].tamanho`, 'TAMANHO_NAO_SE_APLICA', 'Este material não usa tamanho');
    }
  }
}

/**
 * Cria a solicitação PENDENTE de um usuário interno para um trabalhador ativo
 * da empresa: de 1 a 20 itens, material ativo e tamanho conforme a
 * classificação do material. A previsão no GHE é a do momento e não exige
 * justificativa do solicitante. Idempotente pela chave; a mesma chave com
 * outra requisição é conflito.
 *
 * @returns {Promise<{repetida: boolean, solicitacao: object, itens: object[]}>}
 * @throws {HttpError} 400 dado inválido; 403 solicitante inativo; 404
 *   trabalhador, material ou solicitante fora da empresa; 409 trabalhador ou
 *   material inativo, material sem classificação de tamanho, chave usada em
 *   outra solicitação
 */
async function criarSolicitacao(pool, {
  empresaId, atorId, funcionarioId, itens, observacao = null, chaveIdempotencia, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(funcionarioId, 'identificador de funcionário');
  const chave = idempotencia.chaveCanonica(chaveIdempotencia);
  if (chave === null) throw recusar('chaveIdempotencia', 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
  const itensN = validarItens(itens);
  const observacaoN = observacaoOpcional(observacao);
  const requisicaoHash = hashDaRequisicao({
    atorId, funcionarioId, observacao: observacaoN, itens: itensN,
  });

  return emTransacao(pool, async (client) => {
    const repetida = await repetirSeJaCriada(client, empresaId, chave, requisicaoHash);
    if (repetida !== null) return repetida;

    await exigirAtorAtivo(client, empresaId, atorId);
    const funcionario = await funcionarioRepo.buscarPorIdParaEntrega(client, empresaId, funcionarioId);
    if (funcionario === null) throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', 'Trabalhador não encontrado');
    if (funcionario.ativo !== true) throw HttpError.conflict('FUNCIONARIO_INATIVO', 'Trabalhador inativo não recebe EPI');

    const materialIds = [...new Set(itensN.map((i) => i.materialId))].sort((a, b) => a - b);
    const materiais = validarMateriaisDaSolicitacao(await materialRepo.listarPorIdsParaVinculo(client, empresaId, materialIds), materialIds);
    validarTamanhos(itensN, materiais);

    const ghe = funcionario.grupoHomogeneoId === null ? null : await gheRepo.buscarPorId(client, empresaId, funcionario.grupoHomogeneoId);
    const previstos = new Set(ghe === null ? [] : await gheMaterialRepo.listarMaterialIdsVinculados(client, empresaId, ghe.id));

    const solicitacao = await solicitacaoRepo.criar(client, {
      empresaId,
      numero: await numeracaoRepo.proximoNumero(client, empresaId),
      funcionarioId,
      gheId: ghe === null ? null : ghe.id,
      origemSolicitacao: 'USUARIO_INTERNO',
      solicitanteUsuarioId: atorId,
      quantidadeItens: itensN.length,
      observacao: observacaoN,
      chave,
      requisicaoHash,
    });
    const gravados = [];
    for (const i of itensN) {
      gravados.push(await itemRepo.criar(client, {
        empresaId,
        solicitacaoId: solicitacao.id,
        materialId: i.materialId,
        tamanho: i.tamanho,
        quantidade: i.quantidade,
        motivo: i.motivo,
        justificativa: i.justificativa,
        previstoNoGhe: previstos.has(i.materialId),
      }));
    }

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_CRIADA,
      referencia: String(solicitacao.id),
      ip,
      dispositivo,
      contexto: {
        solicitacaoId: solicitacao.id,
        numero: solicitacao.numero,
        funcionarioId,
        gheId: solicitacao.gheId,
        origemSolicitacao: solicitacao.origemSolicitacao,
        solicitanteId: atorId,
        temObservacao: observacaoN !== null,
        itens: gravados.map((g) => ({
          itemId: g.id, materialId: g.materialId, tamanho: g.tamanho, quantidade: g.quantidade, motivo: g.motivo, previstoNoGhe: g.previstoNoGhe,
        })),
        idempotencia: { chave, requisicaoHash },
      },
      dadosNovos: { status: solicitacao.status, quantidadeItens: solicitacao.quantidadeItens },
    });

    return { repetida: false, ...await visaoDaSolicitacao(client, empresaId, solicitacao, dataOperacional()) };
  });
}

// Regras da decisão que dependem dos itens gravados: quantidade, justificativas e fora do GHE.
function decisaoFinalDoItem(x, item) {
  if (x.decisao === 'REPROVADO') {
    return { item, decisao: 'REPROVADO', quantidadeAprovada: 0, justificativa: x.justificativa };
  }
  const quantidadeAprovada = x.quantidadeAprovada ?? item.quantidade;
  const campo = `decisoes[${x.indice}]`;
  if (quantidadeAprovada > item.quantidade) {
    throw recusar(`${campo}.quantidadeAprovada`, 'QUANTIDADE_APROVADA_INVALIDA', 'A quantidade aprovada não pode passar da solicitada');
  }
  if (quantidadeAprovada < item.quantidade && x.justificativa === null) {
    throw recusar(`${campo}.justificativa`, 'JUSTIFICATIVA_OBRIGATORIA', 'Justificativa obrigatória quando a quantidade aprovada é menor que a solicitada');
  }
  if (!item.previstoNoGhe && x.justificativa === null) {
    throw recusar(`${campo}.justificativa`, 'JUSTIFICATIVA_FORA_GHE_OBRIGATORIA', 'O EPI não está previsto no GHE do trabalhador: informe a justificativa da aprovação');
  }
  return { item, decisao: 'APROVADO', quantidadeAprovada, justificativa: x.justificativa };
}

function resultadoDaDecisao(finais) {
  const aprovados = finais.filter((f) => f.decisao === 'APROVADO');
  if (aprovados.length === 0) return 'REPROVADA';
  const integral = aprovados.length === finais.length && aprovados.every((f) => f.quantidadeAprovada === f.item.quantidade);
  return integral ? 'APROVADA' : 'APROVADA_PARCIAL';
}

/**
 * Decisão da Segurança do Trabalho: todos os itens e o cabeçalho num ato só.
 * O resultado do cabeçalho sai das decisões (APROVADA, APROVADA_PARCIAL ou
 * REPROVADA). Aprovar exige trabalhador e materiais ativos e trava os pares
 * dos itens aprovados antes de gravar, mas não exige estoque: com U = 0 a
 * demanda aumenta e a solicitação fica aguardando estoque, de forma derivada.
 * Quem criou a solicitação não decide a própria.
 *
 * @returns {Promise<{solicitacao: object, itens: object[]}>}
 * @throws {HttpError} 400 decisão inválida ou incompleta; 403 decisor inativo ou
 *   autodecisão; 404 solicitação, decisor ou material fora da empresa; 409
 *   solicitação que não está PENDENTE, trabalhador ou material inativo
 */
async function decidirSolicitacao(pool, {
  empresaId, atorId, solicitacaoId, decisoes, hoje, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(solicitacaoId, 'identificador de solicitação');
  const dataOperacionalAtual = exigirDataOpcional(hoje);
  const decisoesN = validarDecisoes(decisoes);

  return emTransacao(pool, async (client) => {
    const solicitacao = await solicitacaoRepo.travarPorId(client, empresaId, solicitacaoId);
    if (solicitacao === null) throw HttpError.notFound('SOLICITACAO_NAO_ENCONTRADA', 'Solicitação não encontrada');
    if (solicitacao.status !== 'PENDENTE') throw HttpError.conflict('SOLICITACAO_NAO_PENDENTE', 'A solicitação já foi decidida ou cancelada');
    await exigirAtorAtivo(client, empresaId, atorId);
    if (solicitacao.origemSolicitacao === 'USUARIO_INTERNO' && solicitacao.solicitanteUsuarioId === atorId) {
      throw HttpError.forbidden('AUTODECISAO_PROIBIDA', 'Quem criou a solicitação não pode aprová-la nem reprová-la');
    }

    const itens = await itemRepo.listarPorSolicitacao(client, empresaId, solicitacaoId);
    const porId = new Map(itens.map((i) => [i.id, i]));
    for (const x of decisoesN) {
      if (!porId.has(x.itemId)) throw recusar(`decisoes[${x.indice}].itemId`, 'ITEM_NAO_PERTENCE', 'O item não pertence a esta solicitação');
    }
    if (decisoesN.length !== itens.length) {
      throw recusar('decisoes', 'DECISAO_INCOMPLETA', 'A decisão precisa cobrir todos os itens da solicitação');
    }
    const finais = decisoesN.map((x) => decisaoFinalDoItem(x, porId.get(x.itemId)));
    const resultado = resultadoDaDecisao(finais);

    const aprovados = finais.filter((f) => f.decisao === 'APROVADO');
    if (aprovados.length > 0) {
      const funcionario = await funcionarioRepo.buscarPorIdParaEntrega(client, empresaId, solicitacao.funcionarioId);
      if (funcionario === null) throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', 'Trabalhador não encontrado');
      if (funcionario.ativo !== true) throw HttpError.conflict('FUNCIONARIO_INATIVO', 'Trabalhador inativo não recebe EPI');
      const materialIds = [...new Set(aprovados.map((f) => f.item.materialId))].sort((a, b) => a - b);
      const materiais = await materialRepo.listarPorIdsParaVinculo(client, empresaId, materialIds);
      const materiaisPorId = new Map(materiais.map((m) => [m.id, m]));
      for (const id of materialIds) {
        const material = materiaisPorId.get(id);
        if (material === undefined) throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', 'Material não encontrado');
        if (material.ativo !== true) throw HttpError.conflict('MATERIAL_INATIVO', 'Material inativo não pode ser aprovado');
      }
      await parRepo.travarPares(client, empresaId, parOrdenados(aprovados.map((f) => ({ materialId: f.item.materialId, tamanho: f.item.tamanho }))));
    }

    const decididos = await itemRepo.decidirTodos(client, empresaId, solicitacaoId, finais.map((f) => ({
      itemId: f.item.id, decisao: f.decisao, quantidadeAprovada: f.quantidadeAprovada, justificativa: f.justificativa,
    })));
    const atualizada = decididos.length === itens.length
      ? await solicitacaoRepo.registrarDecisao(client, empresaId, solicitacaoId, { status: resultado, decididaPor: atorId })
      : null;
    if (atualizada === null) throw HttpError.conflict('SOLICITACAO_ALTERADA', 'A solicitação foi alterada por outra operação');

    const visao = await visaoDaSolicitacao(client, empresaId, atualizada, dataOperacionalAtual);
    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_DECIDIDA,
      referencia: String(solicitacaoId),
      ip,
      dispositivo,
      contexto: {
        solicitacaoId,
        numero: solicitacao.numero,
        funcionarioId: solicitacao.funcionarioId,
        resultado,
        itens: finais.map((f) => ({
          itemId: f.item.id,
          materialId: f.item.materialId,
          tamanho: f.item.tamanho,
          quantidadeSolicitada: f.item.quantidade,
          decisao: f.decisao,
          quantidadeAprovada: f.quantidadeAprovada,
          previstoNoGhe: f.item.previstoNoGhe,
          comJustificativa: f.justificativa !== null,
        })),
        cobertura: visao.itens.filter((i) => i.cobertura !== null).map((i) => ({ itemId: i.id, coberta: i.cobertura.coberta, semCobertura: i.cobertura.semCobertura })),
      },
      dadosAnteriores: { status: 'PENDENTE' },
      dadosNovos: { status: resultado },
    });
    return visao;
  });
}

/**
 * Cancela a solicitação PENDENTE, e só o próprio solicitante a cancela. Depois
 * de decidida, entregue ou cancelada, não. Solicitação de autoatendimento não
 * tem solicitante interno e não é cancelada por esta via. A justificativa é
 * opcional.
 *
 * @throws {HttpError} 400 justificativa inválida; 403 não é o solicitante ou
 *   está inativo; 404 solicitação fora da empresa; 409 não está PENDENTE
 */
async function cancelarSolicitacao(pool, {
  empresaId, atorId, solicitacaoId, justificativa = null, hoje, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(solicitacaoId, 'identificador de solicitação');
  const dataOperacionalAtual = exigirDataOpcional(hoje);
  const justificativaN = justificativaOpcional(justificativa, 'justificativa');

  return emTransacao(pool, async (client) => {
    const solicitacao = await solicitacaoRepo.travarPorId(client, empresaId, solicitacaoId);
    if (solicitacao === null) throw HttpError.notFound('SOLICITACAO_NAO_ENCONTRADA', 'Solicitação não encontrada');
    if (solicitacao.origemSolicitacao !== 'USUARIO_INTERNO' || solicitacao.solicitanteUsuarioId !== atorId) {
      throw HttpError.forbidden('CANCELAMENTO_NAO_PERMITIDO', 'Só o próprio solicitante cancela a solicitação');
    }
    await exigirAtorAtivo(client, empresaId, atorId);
    if (solicitacao.status !== 'PENDENTE') throw HttpError.conflict('SOLICITACAO_NAO_PENDENTE', 'A solicitação já foi decidida ou cancelada');

    const cancelada = await solicitacaoRepo.cancelar(client, empresaId, solicitacaoId, { canceladaPor: atorId, justificativa: justificativaN });
    if (cancelada === null) throw HttpError.conflict('SOLICITACAO_ALTERADA', 'A solicitação foi alterada por outra operação');

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_CANCELADA,
      referencia: String(solicitacaoId),
      descricao: justificativaN,
      ip,
      dispositivo,
      contexto: {
        solicitacaoId, numero: solicitacao.numero, funcionarioId: solicitacao.funcionarioId, comJustificativa: justificativaN !== null,
      },
      dadosAnteriores: { status: 'PENDENTE' },
      dadosNovos: { status: 'CANCELADA' },
    });
    return visaoDaSolicitacao(client, empresaId, cancelada, dataOperacionalAtual);
  });
}

/**
 * Consulta uma solicitação da empresa: cabeçalho, decisão, itens, cobertura e
 * posição atuais e situação operacional derivada. Só leitura, num retrato
 * único do banco.
 *
 * @throws {HttpError} 404 solicitação fora da empresa
 */
async function buscarSolicitacao(pool, { empresaId, solicitacaoId, hoje }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(solicitacaoId, 'identificador de solicitação');
  const dataOperacionalAtual = exigirDataOpcional(hoje);

  return emLeitura(pool, async (client) => {
    const solicitacao = await solicitacaoRepo.buscarPorId(client, empresaId, solicitacaoId);
    if (solicitacao === null) throw HttpError.notFound('SOLICITACAO_NAO_ENCONTRADA', 'Solicitação não encontrada');
    return visaoDaSolicitacao(client, empresaId, solicitacao, dataOperacionalAtual);
  });
}

module.exports = {
  LIMITE_ITENS, criarSolicitacao, decidirSolicitacao, cancelarSolicitacao, buscarSolicitacao, hashDaRequisicao,
};
