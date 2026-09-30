'use strict';

const { mascararCpf } = require('../utils/normalizacao');

/**
 * Forma pública das respostas da entrega de EPI e da ficha: só o que a tela
 * precisa. Nunca saem chave de idempotência, hash da requisição, IP,
 * User-Agent, empresa da sessão, CPF completo nem saldo atual dentro do
 * lote histórico. hashConteudo sai: é o checksum histórico, não assinatura.
 */

const fichaPublica = (ficha) => (ficha === null ? null : {
  id: ficha.id, numero: ficha.numero, funcionarioId: ficha.funcionarioId, criadaEm: ficha.criadaEm,
});

const itemPublico = (i) => ({
  id: i.id,
  materialId: i.materialId,
  loteId: i.loteId,
  quantidade: i.quantidade,
  motivo: i.motivo,
  justificativa: i.justificativa,
  previstoNoGhe: i.previstoNoGhe,
  justificativaForaGhe: i.justificativaForaGhe,
  material: { ...i.material },
  lote: { tamanho: i.lote.tamanho, caNumero: i.lote.caNumero, caValidade: i.lote.caValidade },
  operacaoId: i.operacaoId,
});

const confirmacaoPublica = (c) => (c === null ? null : {
  modo: c.modo,
  tracos: c.tracos,
  declaracaoVersao: c.declaracaoVersao,
  declaracaoTexto: c.declaracaoTexto,
  confirmadaEm: c.confirmadaEm,
  hashConteudo: c.hashConteudo,
});

function entregaPublica({ entrega, ficha, itens, confirmacao }) {
  return {
    id: entrega.id,
    ficha: { id: ficha.id, numero: ficha.numero, funcionarioId: ficha.funcionarioId },
    origem: entrega.origem,
    entregueEm: entrega.entregueEm,
    dataOperacional: entrega.dataOperacional,
    empresa: { ...entrega.empresa },
    trabalhador: { ...entrega.trabalhador },
    ghe: entrega.ghe === null ? null : { ...entrega.ghe },
    responsavel: { ...entrega.responsavel },
    itens: itens.map(itemPublico),
    confirmacao: confirmacaoPublica(confirmacao),
  };
}

/** Cadastro ATUAL do trabalhador, com CPF mascarado; não é snapshot histórico. */
const funcionarioAtualPublico = (f) => ({
  id: f.id,
  nome: f.nome,
  matricula: f.matricula,
  cpfMascarado: mascararCpf(f.cpf),
  setor: f.setor,
  funcao: f.funcao,
  ativo: f.ativo,
});

module.exports = { entregaPublica, itemPublico, confirmacaoPublica, fichaPublica, funcionarioAtualPublico };
