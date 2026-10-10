'use strict';

const { z } = require('zod');

/**
 * Schema do preview da importação GHE/EPI (Incremento 5B). Só a ESTRUTURA do lote: até 1000 linhas (barreira de
 * domínio, independente do limite de 512 KiB do corpo), cada campo texto de até 500 caracteres ou nulo, `linha` opcional
 * (número da linha na planilha). `strictObject` em tudo: empresa, usuário e qualquer resultado calculado nunca vêm do
 * cliente. O conteúdo de cada linha (formato do código, descrição, EPI, classificação) é analisado pelo servidor e
 * volta como resultado POR LINHA, nunca como erro do lote.
 */

const LINHAS_MAXIMO = 1000;
const TEXTO_MAXIMO = 500;
const LINHA_MAXIMA = 1048576;

const texto = z.string().max(TEXTO_MAXIMO).nullable().optional();

const linha = z.strictObject({
  ghe: texto,
  descricao: texto,
  epi: texto,
  classificacao: texto,
  linha: z.number().int().min(2).max(LINHA_MAXIMA).optional(),
});

const previa = {
  body: z.strictObject({ linhas: z.array(linha).min(1).max(LINHAS_MAXIMO) }),
};

// A confirmação recebe de novo as linhas ORIGINAIS (nunca o resultado do preview): o mesmo contrato estrutural.
const confirmar = previa;

module.exports = { previa, confirmar, LINHAS_MAXIMO, TEXTO_MAXIMO };
