'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const entregaRepo = require('../repositories/entrega-epi.repository');
const itemRepo = require('../repositories/entrega-epi-item.repository');
const confirmacaoRepo = require('../repositories/entrega-epi-confirmacao.repository');
const fichaRepo = require('../repositories/ficha-epi.repository');

/**
 * O que a entrega DIRETA (Bloco 10) e a entrega por solicitação (12C-2)
 * realmente compartilham: a validação da confirmação, o hash de conteúdo
 * histórico, o resultado repetido da idempotência, as cópias do documento e as
 * regras de classificação do material e de lote utilizável. Foi movido do
 * serviço da DIRETA sem mudar a lógica; o que é só de uma das duas entregas
 * continua no serviço dela.
 */

const LIMITE_ITENS = 20;
const LIMITE_INTEGER_POSTGRES = 2147483647;
// Óculos: os dois tipos oficiais e o nome histórico (12G-8); a constante segue exportada pelo legado.
const classificacao = require('../utils/classificacao-material');

const { ehOculos, TIPO_OCULOS_LEGADO: TIPO_OCULOS } = classificacao;
const { MODOS, DECLARACAO_VERSAO_FORMATO, DECLARACAO_TEXTO_MAXIMO } = confirmacaoRepo;

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
 * Checksum SHA-256 do conteúdo histórico da entrega, a partir do que está
 * gravado: cabeçalho e cópias congeladas, itens com lote e material,
 * confirmação. Não inclui o próprio hash, saldos nem ids de operação. É
 * detecção de divergência, não assinatura criptográfica.
 *
 * O vínculo do item com o item da solicitação (066) entra no conteúdo só
 * quando existe: a entrega DIRETA não tem vínculo, e por isso o conteúdo
 * dela, e o hash, continuam byte a byte os de antes da 12C.
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
        // Grupo de proteção (082) entra SÓ quando existe: o hash das entregas anteriores não muda.
        ...(i.material.grupoProtecao === null || i.material.grupoProtecao === undefined ? {} : { grupoProtecao: i.material.grupoProtecao }),
      },
      ...(i.solicitacaoItemId === null || i.solicitacaoItemId === undefined ? {} : { solicitacaoItemId: i.solicitacaoItemId }),
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

const copiaDoMaterial = (m) => ({
  nome: m.nome.trim(), tipo: aparar(m.tipo), codigoInterno: aparar(m.codigoInterno), unidade: m.unidade.trim(),
  prazoUsoDias: m.prazoUsoDias, oculosComGrau: m.oculosComGrau, exigeCa: m.exigeCa, grupoProtecao: aparar(m.grupoProtecao),
});

/** O material precisa estar classificado quanto ao prazo, ao tamanho e (óculos) ao grau antes de ser entregue. */
function exigirClassificacaoDoMaterial(material) {
  if (!inteiroPositivo(material.prazoUsoDias)) {
    throw HttpError.conflict('MATERIAL_PRAZO_NAO_CLASSIFICADO', 'Defina o prazo de uso do material antes de entregá-lo');
  }
  if (material.exigeTamanho === null) {
    throw HttpError.conflict('MATERIAL_TAMANHO_NAO_CLASSIFICADO', 'Defina no cadastro se o material exige tamanho antes de entregá-lo');
  }
  // V2: pela classificação (EPI + Proteção ocular, qualquer tipo); LEGADO: pelos nomes históricos.
  if (classificacao.exigeOculosComGrau(material) && material.oculosComGrau === null) {
    throw HttpError.conflict('MATERIAL_OCULOS_NAO_CLASSIFICADO', 'Defina no cadastro se os óculos são com ou sem grau antes de entregá-los');
  }
}

/** CA do lote: exigido e dentro da validade (vale até o fim do dia) quando o material exige CA. */
function exigirCaValidoDoLote(lote, material, hoje) {
  if (material.exigeCa) {
    if (lote.caValidade === null) throw HttpError.conflict('CA_AUSENTE', 'Este material exige lote com CA');
    if (lote.caValidade < hoje) throw HttpError.conflict('CA_VENCIDO', 'O CA deste lote está vencido');
  }
}

function exigirSaldoDoLote(lote, quantidade) {
  if (quantidade > lote.saldo) throw HttpError.conflict('SALDO_INSUFICIENTE', 'Quantidade maior que o saldo do lote');
}

module.exports = {
  LIMITE_ITENS,
  LIMITE_INTEGER_POSTGRES,
  TIPO_OCULOS,
  exigirId,
  inteiroPositivo,
  recusar,
  emTransacao,
  normalizarTracos,
  declaracaoValida,
  validarConfirmacao,
  calcularHashConteudo,
  aparar,
  enderecoDaEmpresa,
  publicarEntrega,
  montarResultado,
  repetirSeJaRegistrada,
  copiaDoMaterial,
  exigirClassificacaoDoMaterial,
  exigirCaValidoDoLote,
  exigirSaldoDoLote,
};
