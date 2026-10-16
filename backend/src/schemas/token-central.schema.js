'use strict';

const { z } = require('zod');
const { idParametro, paginacaoQuery } = require('./campos.schema');
const { normalizarIp } = require('../utils/ip');
const { identificar } = require('./token-atendimento.schema');

/**
 * Atendimento Token — Central Administrativa (Etapa H). Só formato; o serviço revalida o domínio. strictObject em tudo: empresa, autoria,
 * tipo da rede, estado e qualquer outro campo NUNCA vêm do cliente (400 VALIDACAO antes de qualquer consulta ao banco).
 */

const CARACTERE_CONTROLE = /\p{Cc}/u;
const DESCRICAO_MAXIMA = 150;

function issue(ctx, codigo, message) {
  ctx.addIssue({ code: 'custom', message, params: { codigo } });
  return z.NEVER;
}

const vazio = { query: z.strictObject({}) };

// Visão geral: nenhuma entrada.
const visaoGeral = vazio;

// Estado da ativação: só o id do dispositivo.
const estadoAtivacao = { params: z.strictObject({ id: idParametro }), query: z.strictObject({}) };

// Prévia: funcionarioId é SÓ um seletor (id interno), nunca CPF, matrícula, GHE, empresa ou atendimento.
const previa = { query: z.strictObject({ funcionarioId: idParametro }) };

// Consulta real da prévia (K7): a MESMA regra de identificação do tablet (CPF só estrutura; matrícula do cadastro), em corpo estrito.
// O identificador vai só no corpo, nunca na URL; empresa, ator, funcionário e GHE nunca vêm do cliente.
const previaIdentificar = { query: z.strictObject({}), body: identificar.body };

// Redes autorizadas: IP exato (IPv4 ou IPv6 canônico). Faixa (CIDR), intervalo, texto livre e endereço não utilizável são recusados.
const IP_NAO_UTILIZAVEL = new Set(['0.0.0.0', '::']);
const enderecoExato = z.string().transform((valor, ctx) => {
  const ip = normalizarIp(valor);
  if (ip === null || IP_NAO_UTILIZAVEL.has(ip)) return issue(ctx, 'IP_INVALIDO', 'Informe um endereço IP exato (sem faixa)');
  return ip;
});
const descricao = z.string().transform((valor, ctx) => {
  const texto = valor.trim().normalize('NFC');
  if (texto.length === 0) return null;
  if (Array.from(texto).length > DESCRICAO_MAXIMA || CARACTERE_CONTROLE.test(texto)) return issue(ctx, 'DESCRICAO_INVALIDA', 'Descrição inválida (até 150 caracteres, sem caracteres de controle)');
  return texto;
}).nullable();

const listarRedes = { query: z.strictObject({ ...paginacaoQuery }) };
const cadastrarRede = { query: z.strictObject({}), body: z.strictObject({ rede: enderecoExato, descricao: descricao.optional() }) };
const desativarRede = { params: z.strictObject({ id: idParametro }), query: z.strictObject({}), body: z.strictObject({}) };

module.exports = { visaoGeral, estadoAtivacao, previa, previaIdentificar, listarRedes, cadastrarRede, desativarRede, DESCRICAO_MAXIMA };
