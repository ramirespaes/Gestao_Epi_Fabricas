'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const funcionarioRepo = require('../repositories/funcionario.repository');
const materialRepo = require('../repositories/material.repository');
const gheRepo = require('../repositories/grupo-homogeneo-exposicao.repository');
const gheMaterialRepo = require('../repositories/ghe-material.repository');
const empresaRepo = require('../repositories/empresa.repository');
const usuarioRepo = require('../repositories/usuario.repository');
const operacaoRepo = require('../repositories/estoque-operacao.repository');
const fichaRepo = require('../repositories/ficha-epi.repository');
const numeracaoRepo = require('../repositories/ficha-epi-numeracao.repository');
const entregaRepo = require('../repositories/entrega-epi.repository');
const itemRepo = require('../repositories/entrega-epi-item.repository');
const confirmacaoRepo = require('../repositories/entrega-epi-confirmacao.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const idempotencia = require('../utils/idempotencia');

/**
 * Registro da entrega de EPI (Bloco 10). Uma transação só: chave de
 * idempotência → trabalhador → ficha → materiais → lotes → validações →
 * numeração (se primeira entrega) → cabeçalho → itens → operações ENTREGA →
 * confirmação → hash de conteúdo → auditoria → COMMIT. Qualquer falha
 * desfaz tudo.
 *
 * Autorização é das rotas (ação REALIZAR_ENTREGA). empresaId e atorId vêm da
 * sessão. As cópias congeladas são lidas aqui, na transação; nada delas vem
 * do cliente. entregue_em e data_operacional são os DEFAULTs do banco.
 *
 * Travas, nesta ordem, para não formar ciclo com entrada e baixa do estoque:
 * advisory da chave → trabalhador (FOR NO KEY UPDATE) → materiais (FOR
 * SHARE, ids crescentes) → lotes (FOR UPDATE, ids crescentes) → contador da
 * numeração. O CHECK de saldo da 042 continua sendo a última barreira.
 */

const LIMITE_ITENS = 20;
const LIMITE_INTEGER_POSTGRES = 2147483647;
const { MOTIVOS, JUSTIFICATIVA_MAXIMA } = itemRepo;
const { MODOS, DECLARACAO_VERSAO_FORMATO, DECLARACAO_TEXTO_MAXIMO } = confirmacaoRepo;
const TIPO_OCULOS = 'Óculos de proteção';
const ACAO_AUDITORIA = 'ENTREGA_REGISTRADA';

// Traços: lista de traços, cada um lista de pontos [x, y] inteiros já
// normalizados pela tela para 0..10000. Os limites cabem nos 24 KiB da 060.
const TRACOS_MAXIMO = 64;
const PONTOS_MAXIMO = 1500;
const COORDENADA_MAXIMA = 10000;
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

/** Mesmo padrão transacional de estoque.service.js. */
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

function validarItens(itens) {
  if (!Array.isArray(itens) || itens.length < 1 || itens.length > LIMITE_ITENS) {
    throw recusar('itens', 'ITENS_FORA_DO_LIMITE', `A entrega precisa ter de 1 a ${LIMITE_ITENS} itens`);
  }
  const lotes = new Set();
  const normalizados = itens.map((item, i) => {
    const campo = `itens[${i}]`;
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw recusar(campo, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    if (!inteiroPositivo(item.materialId)) throw recusar(`${campo}.materialId`, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    if (!inteiroPositivo(item.loteId)) throw recusar(`${campo}.loteId`, 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
    if (!inteiroPositivo(item.quantidade) || item.quantidade > LIMITE_INTEGER_POSTGRES) {
      throw recusar(`${campo}.quantidade`, 'QUANTIDADE_INVALIDA', 'Quantidade inválida');
    }
    if (!MOTIVOS.includes(item.motivo)) throw recusar(`${campo}.motivo`, 'VALOR_NAO_PERMITIDO', 'Valor não permitido');
    const justificativa = justificativaOpcional(item.justificativa, `${campo}.justificativa`);
    if (item.motivo === 'OUTRO' && justificativa === null) {
      throw recusar(`${campo}.justificativa`, 'JUSTIFICATIVA_OBRIGATORIA', 'Justificativa obrigatória para o motivo OUTRO');
    }
    const justificativaForaGhe = justificativaOpcional(item.justificativaForaGhe, `${campo}.justificativaForaGhe`);
    if (lotes.has(item.loteId)) throw recusar('itens', 'LOTE_REPETIDO', 'Cada lote aparece uma vez só na entrega');
    lotes.add(item.loteId);
    return {
      materialId: item.materialId, loteId: item.loteId, quantidade: item.quantidade, motivo: item.motivo, justificativa, justificativaForaGhe,
    };
  });
  // Ordem canônica: a mesma entrega lógica vira a mesma requisição, qualquer que seja a ordem recebida.
  return normalizados.sort((a, b) => a.loteId - b.loteId);
}

/** Cópia limpa dos traços, ou null quando a estrutura não é a esperada. */
function normalizarTracos(tracos) {
  if (!Array.isArray(tracos) || tracos.length === 0 || tracos.length > TRACOS_MAXIMO) return null;
  let pontos = 0;
  const copia = [];
  for (const traco of tracos) {
    if (!Array.isArray(traco) || traco.length === 0) return null;
    pontos += traco.length;
    if (pontos > PONTOS_MAXIMO) return null;
    const pontosDoTraco = [];
    for (const ponto of traco) {
      if (!Array.isArray(ponto) || ponto.length !== 2) return null;
      const [x, y] = ponto;
      if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0 || x > COORDENADA_MAXIMA || y > COORDENADA_MAXIMA) return null;
      pontosDoTraco.push([x, y]);
    }
    copia.push(pontosDoTraco);
  }
  return copia;
}

// O texto é gravado exatamente como confirmado: sem aparar nem normalizar.
// Quebra de linha é texto; qualquer outro caractere de controle não.
function declaracaoValida(texto) {
  if (typeof texto !== 'string' || texto.trim() !== texto) return false;
  const tamanho = Array.from(texto).length;
  return tamanho >= 1 && tamanho <= DECLARACAO_TEXTO_MAXIMO && !CARACTERE_CONTROLE.test(texto.replace(/\n/g, ''));
}

function validarConfirmacao(confirmacao) {
  if (confirmacao === null || typeof confirmacao !== 'object' || Array.isArray(confirmacao)) {
    throw recusar('confirmacao', 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
  }
  if (!MODOS.includes(confirmacao.modo)) throw recusar('confirmacao.modo', 'VALOR_NAO_PERMITIDO', 'Valor não permitido');
  const semTracos = confirmacao.tracos === null || confirmacao.tracos === undefined;
  let tracos = null;
  if (confirmacao.modo === 'DESENHO') {
    if (semTracos) throw recusar('confirmacao.tracos', 'TRACOS_OBRIGATORIOS', 'A assinatura desenhada precisa dos traços');
    tracos = normalizarTracos(confirmacao.tracos);
    if (tracos === null) throw recusar('confirmacao.tracos', 'TRACOS_INVALIDOS', 'Traços inválidos');
  } else if (!semTracos) {
    throw recusar('confirmacao.tracos', 'TRACOS_NAO_SE_APLICAM', 'O aceite presencial não tem traços');
  }
  if (typeof confirmacao.declaracaoVersao !== 'string' || !DECLARACAO_VERSAO_FORMATO.test(confirmacao.declaracaoVersao)) {
    throw recusar('confirmacao.declaracaoVersao', 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
  }
  if (!declaracaoValida(confirmacao.declaracaoTexto)) {
    throw recusar('confirmacao.declaracaoTexto', 'DECLARACAO_INVALIDA', 'Texto da declaração inválido');
  }
  return {
    modo: confirmacao.modo, tracos, declaracaoVersao: confirmacao.declaracaoVersao, declaracaoTexto: confirmacao.declaracaoTexto,
  };
}

/**
 * Hash da requisição lógica: trabalhador, itens em ordem canônica de lote e a
 * confirmação. Chave, ator, IP, dispositivo e tudo que o servidor gera ficam
 * de fora.
 */
function hashDaRequisicao({ funcionarioId, itens, confirmacao }) {
  const itensCanonicos = [...itens]
    .sort((a, b) => a.loteId - b.loteId)
    .map((i) => [i.materialId, i.loteId, i.quantidade, i.motivo, i.justificativa ?? null, i.justificativaForaGhe ?? null]);
  return idempotencia.hashRequisicao([
    'ENTREGA', funcionarioId, itensCanonicos, confirmacao.modo, confirmacao.tracos ?? null, confirmacao.declaracaoVersao, confirmacao.declaracaoTexto,
  ]);
}

/**
 * Checksum SHA-256 do conteúdo histórico da entrega, a partir do que está
 * gravado: cabeçalho e cópias congeladas, itens com lote e material,
 * confirmação. Não inclui o próprio hash, saldos nem ids de operação. É
 * detecção de divergência, não assinatura criptográfica.
 */
function calcularHashConteudo({ entrega, ficha, itens, confirmacao }) {
  const conteudo = {
    entrega: {
      empresaId: entrega.empresaId,
      fichaNumero: ficha.numero,
      chaveIdempotencia: entrega.chaveIdempotencia,
      origem: entrega.origem,
      entregueEm: entrega.entregueEmCanonico,
      dataOperacional: entrega.dataOperacional,
    },
    empresa: {
      nome: entrega.empresa.nome, cnpj: entrega.empresa.cnpj, endereco: entrega.empresa.endereco ?? null, cidade: entrega.empresa.cidade ?? null, uf: entrega.empresa.uf ?? null,
    },
    trabalhador: {
      nome: entrega.trabalhador.nome, matricula: entrega.trabalhador.matricula, funcao: entrega.trabalhador.funcao ?? null, setor: entrega.trabalhador.setor ?? null,
    },
    ghe: entrega.ghe === null ? null : { id: entrega.ghe.id, nome: entrega.ghe.nome },
    responsavel: { id: entrega.responsavel.id, nome: entrega.responsavel.nome },
    itens: itens.map((i) => ({
      materialId: i.materialId,
      loteId: i.loteId,
      tamanho: i.lote.tamanho ?? null,
      caNumero: i.lote.caNumero ?? null,
      caValidade: i.lote.caValidade ?? null,
      quantidade: i.quantidade,
      motivo: i.motivo,
      justificativa: i.justificativa ?? null,
      previstoNoGhe: i.previstoNoGhe,
      justificativaForaGhe: i.justificativaForaGhe ?? null,
      material: {
        nome: i.material.nome, tipo: i.material.tipo ?? null, codigoInterno: i.material.codigoInterno ?? null, unidade: i.material.unidade,
        prazoUsoDias: i.material.prazoUsoDias, oculosComGrau: i.material.oculosComGrau ?? null, exigeCa: i.material.exigeCa,
      },
    })),
    confirmacao: {
      modo: confirmacao.modo, tracos: confirmacao.tracos ?? null, declaracaoVersao: confirmacao.declaracaoVersao, declaracaoTexto: confirmacao.declaracaoTexto,
    },
  };
  return crypto.createHash('sha256').update(JSON.stringify(conteudo)).digest('hex');
}

const aparar = (valor) => (typeof valor === 'string' && valor.trim().length > 0 ? valor.trim() : null);

// "Rua, número - complemento - bairro", só com o que existe.
function enderecoDaEmpresa(empresa) {
  const logradouro = [aparar(empresa.endereco), aparar(empresa.numero)].filter((p) => p !== null).join(', ');
  const partes = [logradouro, aparar(empresa.complemento), aparar(empresa.bairro)].filter((p) => p !== null && p.length > 0);
  return partes.length === 0 ? null : partes.join(' - ');
}

function publicarEntrega(entrega) {
  const { requisicaoHash, entregueEmCanonico, ...publica } = entrega;
  return publica;
}

async function montarResultado(client, empresaId, entrega, repetida) {
  const [ficha, itens, confirmacao] = await Promise.all([
    fichaRepo.buscarPorId(client, empresaId, entrega.fichaId),
    itemRepo.listarPorEntrega(client, empresaId, entrega.id),
    confirmacaoRepo.buscarPorEntrega(client, empresaId, entrega.id),
  ]);
  return {
    repetida,
    ficha: { id: ficha.id, numero: ficha.numero, funcionarioId: ficha.funcionarioId },
    entrega: publicarEntrega(entrega),
    itens,
    confirmacao,
  };
}

// Consulto a chave antes de qualquer regra: se a entrega já foi feita, a
// repetição recebe o resultado original. A trava vale até o fim da transação.
async function repetirSeJaRegistrada(client, empresaId, chave, requisicaoHash) {
  await entregaRepo.travarChave(client, empresaId, chave);
  const existente = await entregaRepo.buscarPorChave(client, empresaId, chave);
  if (existente === null) return null;
  if (existente.requisicaoHash !== requisicaoHash) {
    throw HttpError.conflict('IDEMPOTENCIA_CONFLITO', 'Esta chave de idempotência já foi usada em outra entrega');
  }
  return montarResultado(client, empresaId, existente, true);
}

function validarMateriais(materiais, idsPedidos) {
  const porId = new Map(materiais.map((m) => [m.id, m]));
  for (const id of idsPedidos) {
    const material = porId.get(id);
    if (material === undefined) throw HttpError.notFound('MATERIAL_NAO_ENCONTRADO', 'Material não encontrado');
    if (material.ativo !== true) throw HttpError.conflict('MATERIAL_INATIVO', 'Material inativo não pode ser entregue');
    if (!inteiroPositivo(material.prazoUsoDias)) {
      throw HttpError.conflict('MATERIAL_PRAZO_NAO_CLASSIFICADO', 'Defina o prazo de uso do material antes de entregá-lo');
    }
    if (material.exigeTamanho === null) {
      throw HttpError.conflict('MATERIAL_TAMANHO_NAO_CLASSIFICADO', 'Defina no cadastro se o material exige tamanho antes de entregá-lo');
    }
    if (material.tipo === TIPO_OCULOS && material.oculosComGrau === null) {
      throw HttpError.conflict('MATERIAL_OCULOS_NAO_CLASSIFICADO', 'Defina no cadastro se os óculos são com ou sem grau antes de entregá-los');
    }
  }
  return porId;
}

function validarLote(lote, material, item, hoje) {
  if (lote === undefined) throw HttpError.notFound('LOTE_NAO_ENCONTRADO', 'Lote não encontrado');
  if (lote.materialId !== item.materialId) throw HttpError.conflict('LOTE_MATERIAL_DIVERGENTE', 'O lote não é do material informado');
  if (material.exigeTamanho && lote.tamanho === null) throw HttpError.conflict('LOTE_SEM_TAMANHO', 'Este material exige lote com tamanho');
  if (material.exigeCa) {
    if (lote.caValidade === null) throw HttpError.conflict('CA_AUSENTE', 'Este material exige lote com CA');
    if (lote.caValidade < hoje) throw HttpError.conflict('CA_VENCIDO', 'O CA deste lote está vencido');
  }
  if (item.quantidade > lote.saldo) throw HttpError.conflict('SALDO_INSUFICIENTE', 'Quantidade maior que o saldo do lote');
}

function decidirGhe(item, previstos) {
  const previsto = previstos.has(item.materialId);
  if (previsto && item.justificativaForaGhe !== null) {
    throw HttpError.conflict('JUSTIFICATIVA_FORA_GHE_NAO_SE_APLICA', 'O EPI está previsto no GHE do trabalhador: não cabe justificativa de exceção');
  }
  if (!previsto && item.justificativaForaGhe === null) {
    throw HttpError.conflict('JUSTIFICATIVA_FORA_GHE_OBRIGATORIA', 'O EPI não está previsto no GHE do trabalhador: informe a justificativa');
  }
  return previsto;
}

const copiaDoMaterial = (m) => ({
  nome: m.nome.trim(), tipo: aparar(m.tipo), codigoInterno: aparar(m.codigoInterno), unidade: m.unidade.trim(),
  prazoUsoDias: m.prazoUsoDias, oculosComGrau: m.oculosComGrau, exigeCa: m.exigeCa,
});

/**
 * Registra a entrega. O trabalhador e os materiais precisam existir na
 * empresa e estar ativos; cada lote precisa ser do material, ter tamanho
 * quando o material exige, CA válido na data operacional quando o material
 * exige CA e saldo para a quantidade. A ficha é criada na primeira entrega.
 *
 * @param {object} dados empresaId e atorId vêm da sessão
 * @returns {Promise<{repetida: boolean, ficha: object, entrega: object, itens: object[], confirmacao: object}>}
 * @throws {HttpError} 400 dado inválido; 404 trabalhador, material, lote ou responsável fora
 *   da empresa; 409 regra de negócio ou chave usada em outra entrega
 */
async function registrarEntrega(pool, {
  empresaId, atorId, funcionarioId, itens, confirmacao, chaveIdempotencia, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(funcionarioId, 'identificador de funcionário');
  const chave = idempotencia.chaveCanonica(chaveIdempotencia);
  if (chave === null) throw recusar('chaveIdempotencia', 'FORMATO_INVALIDO', MSG_FORMATO_INVALIDO);
  const itensN = validarItens(itens);
  const confirmacaoN = validarConfirmacao(confirmacao);
  const requisicaoHash = hashDaRequisicao({ funcionarioId, itens: itensN, confirmacao: confirmacaoN });

  return emTransacao(pool, async (client) => {
    const repetida = await repetirSeJaRegistrada(client, empresaId, chave, requisicaoHash);
    if (repetida !== null) return repetida;

    const hoje = await entregaRepo.dataOperacionalDaTransacao(client);
    const funcionario = await funcionarioRepo.buscarPorIdParaEntrega(client, empresaId, funcionarioId);
    if (funcionario === null) throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', 'Trabalhador não encontrado');
    if (funcionario.ativo !== true) throw HttpError.conflict('FUNCIONARIO_INATIVO', 'Trabalhador inativo não recebe EPI');
    // Lida depois da trava do trabalhador: uma primeira entrega simultânea já terá criado a ficha.
    const fichaExistente = await fichaRepo.buscarPorFuncionario(client, empresaId, funcionarioId);

    const materialIds = [...new Set(itensN.map((i) => i.materialId))].sort((a, b) => a - b);
    const materiais = validarMateriais(await materialRepo.listarPorIdsParaVinculo(client, empresaId, materialIds), materialIds);
    const loteIds = itensN.map((i) => i.loteId);
    const lotes = new Map((await operacaoRepo.travarLotesParaEntrega(client, empresaId, loteIds)).map((l) => [l.loteId, l]));
    for (const item of itensN) {
      validarLote(lotes.get(item.loteId), materiais.get(item.materialId), item, hoje);
    }

    const ghe = funcionario.grupoHomogeneoId === null ? null : await gheRepo.buscarPorId(client, empresaId, funcionario.grupoHomogeneoId);
    const previstos = new Set(ghe === null ? [] : await gheMaterialRepo.listarMaterialIdsVinculados(client, empresaId, ghe.id));
    const decisoes = itensN.map((item) => ({ ...item, previstoNoGhe: decidirGhe(item, previstos) }));

    const empresa = await empresaRepo.buscarDetalhesPorId(client, empresaId);
    if (empresa === null) throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada');
    const responsavel = await usuarioRepo.buscarPorId(client, empresaId, atorId);
    if (responsavel === null) throw HttpError.notFound('RESPONSAVEL_NAO_ENCONTRADO', 'Responsável não encontrado');

    const ficha = fichaExistente ?? await fichaRepo.criar(client, {
      empresaId, funcionarioId, numero: await numeracaoRepo.proximoNumero(client, empresaId),
    });
    const entrega = await entregaRepo.criar(client, {
      empresaId,
      fichaId: ficha.id,
      responsavelId: atorId,
      gheId: ghe === null ? null : ghe.id,
      chave,
      requisicaoHash,
      empresa: {
        nome: empresa.razaoSocial.trim(), cnpj: empresa.cnpj, endereco: enderecoDaEmpresa(empresa), cidade: aparar(empresa.cidade), uf: aparar(empresa.uf)?.toUpperCase() ?? null,
      },
      trabalhador: { nome: funcionario.nome.trim(), matricula: funcionario.matricula.trim(), funcao: aparar(funcionario.funcao), setor: aparar(funcionario.setor) },
      gheNome: ghe === null ? null : ghe.nome.trim(),
      responsavelNome: responsavel.nome.trim(),
    });

    const saldosAntes = [];
    const itensGravados = [];
    for (const decisao of decisoes) {
      const lote = lotes.get(decisao.loteId);
      saldosAntes.push({ loteId: lote.loteId, saldo: lote.saldo });
      const item = await itemRepo.criar(client, {
        empresaId,
        entregaId: entrega.id,
        materialId: decisao.materialId,
        loteId: decisao.loteId,
        quantidade: decisao.quantidade,
        motivo: decisao.motivo,
        justificativa: decisao.justificativa,
        previstoNoGhe: decisao.previstoNoGhe,
        justificativaForaGhe: decisao.justificativaForaGhe,
        material: copiaDoMaterial(materiais.get(decisao.materialId)),
      });
      const operacao = await operacaoRepo.registrarEntrega(client, {
        empresaId, loteId: item.loteId, usuarioId: atorId, quantidade: item.quantidade, entregaItemId: item.id,
      });
      itensGravados.push({ item, operacao });
    }

    const itensLidos = await itemRepo.listarPorEntrega(client, empresaId, entrega.id);
    const hashConteudo = calcularHashConteudo({ entrega, ficha, itens: itensLidos, confirmacao: confirmacaoN });
    const confirmacaoGravada = await confirmacaoRepo.criar(client, {
      empresaId, entregaId: entrega.id, ...confirmacaoN, hashConteudo, ip, dispositivo,
    });
    const lotesDepois = await operacaoRepo.listarLotes(client, empresaId, loteIds);

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_AUDITORIA,
      referencia: String(entrega.id),
      ip,
      dispositivo,
      contexto: {
        entregaId: entrega.id,
        ficha: { id: ficha.id, numero: ficha.numero },
        funcionarioId,
        gheId: ghe === null ? null : ghe.id,
        responsavelId: atorId,
        itens: itensGravados.map(({ item, operacao }) => ({
          itemId: item.id, materialId: item.materialId, loteId: item.loteId, quantidade: item.quantidade, motivo: item.motivo, previstoNoGhe: item.previstoNoGhe, operacaoId: operacao.id,
        })),
        confirmacao: { modo: confirmacaoGravada.modo, declaracaoVersao: confirmacaoGravada.declaracaoVersao, hashConteudo },
        idempotencia: { chave, requisicaoHash },
      },
      dadosAnteriores: { saldos: saldosAntes },
      dadosNovos: { saldos: lotesDepois.map((l) => ({ loteId: l.loteId, saldo: l.saldo })) },
    });

    return {
      repetida: false,
      ficha: { id: ficha.id, numero: ficha.numero, funcionarioId: ficha.funcionarioId },
      entrega: publicarEntrega(entrega),
      itens: itensLidos,
      confirmacao: confirmacaoGravada,
    };
  });
}

module.exports = {
  LIMITE_ITENS, registrarEntrega, hashDaRequisicao, calcularHashConteudo, normalizarTracos, declaracaoValida,
};
