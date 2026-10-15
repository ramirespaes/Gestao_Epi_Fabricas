'use strict';

const { z } = require('zod');
const { idParametro, paginacaoQuery, textoCurto } = require('./campos.schema');

/**
 * Atendimento Token — administração dos dispositivos (Etapa B). Só formato: o serviço revalida o domínio e a autoridade.
 * strictObject em tudo: empresa, autoria (`criadoPor`, `revogadoPor`), identificador, credencial, situação, carimbos e
 * comunicação NUNCA vêm do cliente — qualquer um deles é 400 VALIDACAO.
 *
 * Limites iguais aos das colunas da migration 086 (code points). Opcional em branco vira null; caractere de controle é recusado.
 */

const NOME_MAXIMO = 100;
const LOCAL_MAXIMO = 150;
const CARACTERE_CONTROLE = /\p{Cc}/u;

function issue(ctx, codigo, message) {
  ctx.addIssue({ code: 'custom', message, params: { codigo } });
  return z.NEVER;
}

const nome = textoCurto(NOME_MAXIMO, 'NOME_INVALIDO', 'Nome do dispositivo inválido (1 a 100 caracteres, sem caracteres de controle)');

/** Texto opcional: aparado e NFC; em branco → null; acima do limite ou com caractere de controle → recusado. */
function textoOpcional(maximo, codigo, mensagem) {
  return z.string().transform((valor, ctx) => {
    const texto = valor.trim().normalize('NFC');
    if (texto.length === 0) return null;
    if (Array.from(texto).length > maximo || CARACTERE_CONTROLE.test(texto)) return issue(ctx, codigo, mensagem);
    return texto;
  }).nullable();
}

const unidade = textoOpcional(NOME_MAXIMO, 'UNIDADE_INVALIDA', 'Unidade inválida');
const setor = textoOpcional(NOME_MAXIMO, 'SETOR_INVALIDO', 'Setor inválido');
const localInstalacao = textoOpcional(LOCAL_MAXIMO, 'LOCAL_INVALIDO', 'Local de instalação inválido');
const fabricante = textoOpcional(NOME_MAXIMO, 'FABRICANTE_INVALIDO', 'Fabricante inválido');
const modelo = textoOpcional(NOME_MAXIMO, 'MODELO_INVALIDO', 'Modelo inválido');
const numeroSerie = textoOpcional(NOME_MAXIMO, 'NUMERO_SERIE_INVALIDO', 'Número de série inválido');

const params = z.strictObject({ id: idParametro });

const listar = { query: z.strictObject({ ...paginacaoQuery }) };

const consultar = { params };

const criar = {
  body: z.strictObject({
    nome,
    unidade: unidade.optional(),
    setor: setor.optional(),
    localInstalacao: localInstalacao.optional(),
    fabricante: fabricante.optional(),
    modelo: modelo.optional(),
    numeroSerie: numeroSerie.optional(),
  }),
};

// Edição: ao menos um campo; null limpa um opcional. O nome nunca é limpo (não é nullable).
const editar = {
  params,
  body: z.strictObject({
    nome: nome.optional(),
    unidade: unidade.optional(),
    setor: setor.optional(),
    localInstalacao: localInstalacao.optional(),
    fabricante: fabricante.optional(),
    modelo: modelo.optional(),
    numeroSerie: numeroSerie.optional(),
  }).superRefine((valor, ctx) => {
    if (Object.values(valor).every((v) => v === undefined)) issue(ctx, 'CORPO_VAZIO', 'Informe ao menos um campo para alterar');
  }),
};

const revogar = { params, body: z.strictObject({}) };

module.exports = { listar, consultar, criar, editar, revogar };
