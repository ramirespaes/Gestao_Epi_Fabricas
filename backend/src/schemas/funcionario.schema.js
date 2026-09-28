'use strict';

const { z } = require('zod');
const {
  idParametro, idCorpo, booleanoQuery, paginacaoQuery, textoCurto, cpfComDigitosVerificadores, dataCalendario,
} = require('./campos.schema');

/**
 * Schemas das rotas de funcionários (Bloco 9, Etapa B). Só formato:
 * existência do GHE, duplicidade de matrícula/CPF e vínculo são do serviço.
 *
 * `cpf` usa `cpfComDigitosVerificadores` (campos.schema.js): sai normalizado
 * com 11 dígitos e com DV conferido — o serviço revalida (fonte única,
 * utils/normalizacao.js). `dataNascimento` usa `dataCalendario` (calendário
 * estrito, ano ≥ 1), a mesma regra promovida de `caValidade`.
 *
 * CPF IMUTÁVEL (decisão definitiva de 2026-09-23): `cpf` existe SÓ em
 * `criar`. Em `alterar` a chave não é declarada — e, como o corpo é
 * strictObject, qualquer presença de `cpf` (igual ou diferente do
 * persistido) é `unrecognized_keys` → 400 CAMPO_NAO_PERMITIDO, decidido
 * pelo middleware de validação antes de controller, transação e auditoria,
 * para qualquer perfil (MASTER incluído). Igual e diferente recebem a MESMA
 * resposta de propósito: distinguir os dois casos daria a quem tem
 * permissão de editar um oráculo para confirmar CPFs por tentativa. CPF
 * cadastrado errado: inativar o funcionário e cadastrar outro.
 *
 * Nenhum campo de usuário do sistema entra aqui (e-mail, senha, perfil):
 * funcionário e usuário são entidades distintas.
 */

const MATRICULA_MAXIMA = 30;
const NOME_MAXIMO = 150;
const SETOR_MAXIMO = 100;
const FUNCAO_MAXIMO = 100;
const CRACHA_MAXIMO = 30;
const TELEFONE_MAXIMO = 20;
const BUSCA_MAXIMA = 100;

const matricula = textoCurto(MATRICULA_MAXIMA, 'MATRICULA_INVALIDA', 'Matrícula inválida');
const nome = textoCurto(NOME_MAXIMO, 'NOME_INVALIDO', 'Nome do funcionário inválido');
const setor = textoCurto(SETOR_MAXIMO, 'SETOR_INVALIDO', 'Setor inválido');
const funcao = textoCurto(FUNCAO_MAXIMO, 'FUNCAO_INVALIDA', 'Função inválida');
const cracha = textoCurto(CRACHA_MAXIMO, 'CRACHA_INVALIDO', 'Crachá inválido');
const telefone = textoCurto(TELEFONE_MAXIMO, 'TELEFONE_INVALIDO', 'Telefone inválido');
const busca = textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido');
const dataNascimento = dataCalendario('DATA_NASCIMENTO_INVALIDA', 'Data de nascimento inválida');
// C4 (migration 040): mesma regra de calendário; a relação com o nascimento
// e o limite de 1900 são do serviço (e dos CHECKs, segunda barreira).
const dataAdmissao = dataCalendario('DATA_ADMISSAO_INVALIDA', 'Data de admissão inválida');
// grupoHomogeneoId em query chega como string: mesma regra de idParametro.
const grupoHomogeneoIdQuery = idParametro;

const paramsComId = z.strictObject({ id: idParametro });

const criar = {
  body: z.strictObject({
    matricula,
    nome,
    cpf: cpfComDigitosVerificadores,
    grupoHomogeneoId: idCorpo.nullable().optional(),
    dataNascimento: dataNascimento.nullable().optional(),
    setor: setor.nullable().optional(),
    funcao: funcao.nullable().optional(),
    cracha: cracha.nullable().optional(),
    telefone: telefone.nullable().optional(),
    dataAdmissao: dataAdmissao.nullable().optional(),
  }),
};

// SEC-008: `cpf` não entra mais na query (URL, histórico, logs de acesso).
// A consulta por CPF é `consultaCpf`, com o CPF no corpo.
const listar = {
  query: z.strictObject({
    ...paginacaoQuery,
    ativo: booleanoQuery.optional(),
    busca: busca.optional(),
    grupoHomogeneoId: grupoHomogeneoIdQuery.optional(),
  }),
};

// C4 (decisão D5): CPF só COMPLETO, com DV conferido, por igualdade exata no
// repositório; nunca parcial. O CPF é único por empresa, então não há
// paginação a pedir.
const consultaCpf = {
  body: z.strictObject({ cpf: cpfComDigitosVerificadores }),
};

const buscar = { params: paramsComId };

const alterar = {
  params: paramsComId,
  body: z.strictObject({
    matricula: matricula.optional(),
    nome: nome.optional(),
    // sem `cpf`: imutável após o cadastro (ver cabeçalho)
    grupoHomogeneoId: idCorpo.nullable().optional(),
    dataNascimento: dataNascimento.nullable().optional(),
    setor: setor.nullable().optional(),
    funcao: funcao.nullable().optional(),
    cracha: cracha.nullable().optional(),
    telefone: telefone.nullable().optional(),
    dataAdmissao: dataAdmissao.nullable().optional(),
  }),
};

const semCorpo = z.strictObject({});
const inativar = { params: paramsComId, body: semCorpo };
const reativar = { params: paramsComId, body: semCorpo };

// ── Importação em lote (C4, decisões D1/D4 de 25/09/2026) ──────────────
// DUAS camadas, de propósito:
//  * `importacao.body` valida só a ESTRUTURA do lote (tipos, tetos
//    grosseiros, até 100 linhas, declaração confirmada). Erro aqui é defeito
//    do cliente → 400 do lote inteiro.
//  * `linhaImportacao` aplica as REGRAS DO CADASTRO a cada linha, no
//    serviço. Erro aqui recusa só aquela linha — as demais seguem.
const LINHAS_POR_LOTE = 100;
const LINHAS_POR_ARQUIVO = 1000;
// O cliente fecha cada lote em 100 linhas OU no limite de bytes do corpo
// (32 KB da API), o que vier primeiro. Com campos longos e acentuados, um
// lote pode ter bem menos de 100 linhas; o teto de lotes acompanha o de
// linhas do arquivo (no pior caso extremo, uma linha por lote).
const LOTES_POR_ARQUIVO = LINHAS_POR_ARQUIVO;
// Teto grosseiro de estrutura (o fino, por campo, é da linhaImportacao):
// uma célula longa demais é problema da LINHA, não do lote.
const TEXTO_ESTRUTURA_MAXIMO = 500;
const textoEstrutura = z.string().max(TEXTO_ESTRUTURA_MAXIMO).nullable().optional();
const numeroLinha = z.number().int().min(2).max(LINHAS_POR_ARQUIVO + 1);

const linhaImportacao = z.strictObject({
  linha: numeroLinha,
  nome,
  cpf: cpfComDigitosVerificadores,
  matricula,
  dataAdmissao,
  dataNascimento: dataNascimento.nullable().optional(),
  // Setor e função (cargo) são obrigatórios pela planilha de importação.
  setor,
  funcao,
  telefone: telefone.nullable().optional(),
});

const linhaEstrutura = z.strictObject({
  linha: numeroLinha,
  nome: textoEstrutura,
  cpf: textoEstrutura,
  matricula: textoEstrutura,
  dataAdmissao: textoEstrutura,
  dataNascimento: textoEstrutura,
  setor: textoEstrutura,
  funcao: textoEstrutura,
  telefone: textoEstrutura,
});

const importacao = {
  body: z.strictObject({
    importacaoId: z.uuid(),
    lote: z.strictObject({
      numero: z.number().int().min(1).max(LOTES_POR_ARQUIVO),
      total: z.number().int().min(1).max(LOTES_POR_ARQUIVO),
    }).refine((l) => l.numero <= l.total, { message: 'Número do lote maior que o total' }),
    arquivo: z.strictObject({
      nome: textoCurto(100, 'ARQUIVO_NOME_INVALIDO', 'Nome do arquivo inválido'),
      formato: z.enum(['xlsx', 'csv']),
      totalLinhas: z.number().int().min(1).max(LINHAS_POR_ARQUIVO),
    }),
    declaracaoLgpd: z.strictObject({
      versao: z.string().min(1).max(60),
      confirmada: z.literal(true),
    }),
    linhas: z.array(linhaEstrutura).min(1).max(LINHAS_POR_LOTE)
      .refine((ls) => new Set(ls.map((l) => l.linha)).size === ls.length, { message: 'Número de linha repetido no lote' }),
  }),
};

module.exports = {
  criar, listar, consultaCpf, buscar, alterar, inativar, reativar, importacao, linhaImportacao, LINHAS_POR_LOTE, LINHAS_POR_ARQUIVO,
};
