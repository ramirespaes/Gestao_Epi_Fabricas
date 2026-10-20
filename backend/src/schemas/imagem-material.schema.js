'use strict';

const { z } = require('zod');
const { paginacaoQuery, textoCurto } = require('./campos.schema');
const { idGrandeParametro } = require('./identificador-grande.schema');

/**
 * Schemas das rotas da biblioteca de imagens de produto (Biblioteca de Imagens, Unidade 4). Só estrutura e formato, sem contexto: não consultam
 * banco, não conhecem empresa nem autorização; existência, isolamento, estado e uso são do serviço (Unidade 3).
 *
 * `strictObject` em toda query e corpo: empresa, ator, criador, estado, versão, hash, bytes e qualquer campo não declarado recebem 400
 * (CAMPO_NAO_PERMITIDO) antes do controller. O identificador da imagem é BIGINT em texto decimal canônico (`idGrandeParametro`).
 * Não há schema de registro de imagem: o cliente NUNCA fornece o descritor (hashes, medidas, bytes) — o registro sai do upload binário
 * processado no servidor. O `enviar` (Unidade 5C-2) valida SÓ a consulta do envio (o nome); o corpo é a imagem em binário e quem o confere é o
 * servidor, pelos bytes, no serviço de envio.
 */

const NOME_MAXIMO = 100;
const BUSCA_MAXIMA = 100;
const TIPO_MAXIMO = 100;

const nome = textoCurto(NOME_MAXIMO, 'NOME_INVALIDO', 'Nome da imagem inválido');

// origem e estado da LISTAGEM: o estado só vale para a biblioteca da empresa (a padrão inativa nunca é listada).
const listar = {
  query: z.strictObject({
    ...paginacaoQuery,
    origem: z.enum(['TODAS', 'PADRAO', 'EMPRESA']).default('TODAS'),
    estado: z.enum(['ATIVA', 'INATIVA', 'TODAS']).default('ATIVA'),
    busca: textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido').optional(),
    tipoNome: textoCurto(TIPO_MAXIMO, 'TIPO_INVALIDO', 'Tipo inválido').optional(),
  }),
};

const params = z.strictObject({ id: idGrandeParametro });
const semCorpo = z.strictObject({});

const renomear = { params, body: z.strictObject({ nome }) };
const inativar = { params, body: semCorpo };
const reativar = { params, body: semCorpo };
// Confirmação explícita: literal `true` (a interface futura a pede ao usuário); false, "true", 1 e ausente são recusados.
const excluir = { params, body: z.strictObject({ confirmacao: z.literal(true) }) };

// Envio binário: a consulta leva só o nome (1 a 100, sem caracteres de controle, repetido ou ausente é 400). Empresa, ator, criador, estado, versão,
// hash, chave, caminho e qualquer outra chave recebem 400 (CAMPO_NAO_PERMITIDO) sem eco do valor.
const enviar = { query: z.strictObject({ nome }) };

module.exports = { listar, renomear, inativar, reativar, excluir, enviar };
