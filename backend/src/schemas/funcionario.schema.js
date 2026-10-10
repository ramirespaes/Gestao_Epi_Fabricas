'use strict';

const { z } = require('zod');
const { normalizarNomeGhe } = require('../utils/normalizacao');
const { SITUACOES } = require('../utils/situacao-funcionario');
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
// Matrícula opcional (12K-E): ausente ou null = sem matrícula; string vazia continua inválida.
const matriculaOpcional = matricula.nullable().optional();
const nome = textoCurto(NOME_MAXIMO, 'NOME_INVALIDO', 'Nome do funcionário inválido');
const setor = textoCurto(SETOR_MAXIMO, 'SETOR_INVALIDO', 'Setor inválido');
const funcao = textoCurto(FUNCAO_MAXIMO, 'FUNCAO_INVALIDA', 'Função inválida');
const cracha = textoCurto(CRACHA_MAXIMO, 'CRACHA_INVALIDO', 'Crachá inválido');
const telefone = textoCurto(TELEFONE_MAXIMO, 'TELEFONE_INVALIDO', 'Telefone inválido');
// 12G-9: a planilha traz o NOME do GHE (grupos_homogeneos_exposicao.nome,
// VARCHAR(150)); existência, empresa e estado ativo são do serviço.
const GHE_NOME_MAXIMO = 150;
const gheNome = textoCurto(GHE_NOME_MAXIMO, 'GHE_INVALIDO', 'GHE inválido');
// Nome GHE da planilha (12K-E): a linha chega normalizada (quebras e espaços viram um espaço). Vazio ou só whitespace é
// "não informado"; só os demais caracteres de controle (ou excesso de tamanho) são "inválido".
const CONTROLE_SEM_QUEBRA = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/;
const gheImportacao = z.string().transform((valor, ctx) => {
  const texto = normalizarNomeGhe(valor);
  if (texto.length === 0) {
    ctx.addIssue({ code: 'custom', message: 'GHE não informado', params: { codigo: 'GHE_NAO_INFORMADO' } });
    return z.NEVER;
  }
  if (Array.from(texto).length > GHE_NOME_MAXIMO || CONTROLE_SEM_QUEBRA.test(texto)) {
    ctx.addIssue({ code: 'custom', message: 'GHE inválido', params: { codigo: 'GHE_INVALIDO' } });
    return z.NEVER;
  }
  return texto;
});
const busca = textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido');
const dataNascimento = dataCalendario('DATA_NASCIMENTO_INVALIDA', 'Data de nascimento inválida');
// C4 (migration 040): mesma regra de calendário; a relação com o nascimento, o limite de 1900 e "não no futuro"
// (S4, pela data civil do relógio injetado) são do serviço (e dos CHECKs, segunda barreira).
const dataAdmissao = dataCalendario('DATA_ADMISSAO_INVALIDA', 'Data de admissão inválida');
// grupoHomogeneoId em query chega como string: mesma regra de idParametro.
const grupoHomogeneoIdQuery = idParametro;

const paramsComId = z.strictObject({ id: idParametro });

// S4: cadastro individual. OBRIGATÓRIOS: nome, cpf, setor, funcao, grupoHomogeneoId (existência, empresa e estado ativo
// são do serviço) e dataAdmissao; texto vazio ou só espaços não vale (textoCurto). OPCIONAIS: matricula, telefone,
// dataNascimento e cracha. A situação nasce ATIVO no banco: `situacao` e `ativo` não existem aqui (strictObject). A
// importação em lote tem o schema próprio (`linhaImportacao`) e não passa por este.
const criar = {
  body: z.strictObject({
    matricula: matriculaOpcional,
    nome,
    cpf: cpfComDigitosVerificadores,
    grupoHomogeneoId: idCorpo,
    dataNascimento: dataNascimento.nullable().optional(),
    setor,
    funcao,
    cracha: cracha.nullable().optional(),
    telefone: telefone.nullable().optional(),
    dataAdmissao,
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
    matricula: matriculaOpcional,
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
// Revelação do CPF na edição: nada vem do cliente além do id da URL (empresa e ator são da sessão); corpo e query vazios, estritos.
const revelarCpf = { params: paramsComId, query: semCorpo, body: semCorpo };
const reativar = { params: paramsComId, body: semCorpo };
// S2: a situação só muda por esta rota (o PATCH genérico não a declara). Valor fora do enum é 400 do schema; transição
// proibida e situação igual à atual são 409 do serviço.
const situacao = { params: paramsComId, body: z.strictObject({ situacao: z.enum(SITUACOES) }) };

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
  matricula: matriculaOpcional,
  // Obrigatória: só "Ativo" (caixa e espaços externos ignorados) é aceito, decidido no serviço.
  situacao: z.string().max(50),
  dataAdmissao,
  dataNascimento: dataNascimento.nullable().optional(),
  // Setor, função (cargo) e GHE são obrigatórios pela planilha de importação.
  setor,
  funcao,
  telefone: telefone.nullable().optional(),
  // Nome da planilha OU escolha explícita do SST na prévia (gheId); o serviço exige um dos dois e revalida o id.
  ghe: gheImportacao.optional(),
  gheId: idCorpo.optional(),
});

const linhaEstrutura = z.strictObject({
  linha: numeroLinha,
  nome: textoEstrutura,
  cpf: textoEstrutura,
  matricula: textoEstrutura,
  situacao: textoEstrutura,
  dataAdmissao: textoEstrutura,
  dataNascimento: textoEstrutura,
  setor: textoEstrutura,
  funcao: textoEstrutura,
  telefone: textoEstrutura,
  ghe: textoEstrutura,
  gheId: z.union([z.number(), z.string()]).nullable().optional(),
});

// GET /funcionarios/importacao/ghes: opções do seletor da prévia; a empresa vem só da sessão, sem parâmetro algum.
const importacaoGhes = { query: z.strictObject({}) };

// GET /funcionarios/ghes (S3): seletor de GHE do formulário; também sem parâmetro algum.
const ghesFormulario = { query: z.strictObject({}) };

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
  criar, listar, consultaCpf, buscar, alterar, inativar, reativar, revelarCpf, situacao, importacao, importacaoGhes, ghesFormulario, linhaImportacao, LINHAS_POR_LOTE, LINHAS_POR_ARQUIVO,
};
