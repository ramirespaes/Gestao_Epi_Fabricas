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
  }),
};

const listar = {
  query: z.strictObject({
    ...paginacaoQuery,
    ativo: booleanoQuery.optional(),
    busca: busca.optional(),
    grupoHomogeneoId: grupoHomogeneoIdQuery.optional(),
  }),
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
  }),
};

const semCorpo = z.strictObject({});
const inativar = { params: paramsComId, body: semCorpo };
const reativar = { params: paramsComId, body: semCorpo };

module.exports = { criar, listar, buscar, alterar, inativar, reativar };
