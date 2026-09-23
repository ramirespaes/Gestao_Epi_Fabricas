'use strict';

const { z } = require('zod');
const { idParametro, booleanoQuery, textoCurto } = require('./campos.schema');

/**
 * Schemas das rotas de grupos de acesso (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3M). Só estrutura e formato, sem contexto: não consultam banco,
 * não conhecem empresa nem autoridade, e não decidem nada de negócio — a
 * unicidade do nome, a existência do grupo e quem pode administrar são do
 * serviço já aprovado na 3J.
 *
 * O QUE NÃO ENTRA POR AQUI: `strictObject` em todos os corpos faz com que
 * qualquer campo não declarado seja rejeitado com 400 antes do controller.
 * É assim que `id`, `empresa_id`, `criado_por` e `criado_em` ficam fora do
 * alcance da API — não por serem ignorados em silêncio, mas por a
 * requisição inteira ser recusada. `ativo` também não é aceito em corpo
 * nenhum: inativar e reativar têm rotas próprias, para que a reativação
 * (que pode restaurar concessões TRUE suspensas) nunca aconteça de carona
 * numa renomeação — decisão da 3J, preservada aqui.
 *
 * `descricao` aceita null explícito, que o serviço interpreta como "limpar
 * a descrição"; ausente significa "não mexer". A distinção entre os dois é
 * o contrato de alterar() e precisa sobreviver à validação.
 */

// grupos_acesso.nome: VARCHAR(100) NOT NULL (migration 020).
const NOME_MAXIMO = 100;
// grupos_acesso.descricao é TEXT (sem limite no banco); o teto aqui é
// proteção de entrada da API, não regra do domínio.
const DESCRICAO_MAXIMA = 500;

const nome = textoCurto(NOME_MAXIMO, 'NOME_INVALIDO', 'Nome do grupo inválido');
const descricao = textoCurto(DESCRICAO_MAXIMA, 'DESCRICAO_INVALIDA', 'Descrição do grupo inválida');

const paramsComId = z.strictObject({ id: idParametro });

const criar = {
  body: z.strictObject({
    nome,
    // Ausente = sem descrição. null explícito também é aceito e significa
    // o mesmo na criação.
    descricao: z.union([descricao, z.null()]).optional(),
  }),
};

const listar = {
  query: z.strictObject({
    // Ausente lista ativos E inativos; true/false filtram explicitamente.
    ativo: booleanoQuery.optional(),
  }),
};

const buscar = { params: paramsComId };

const alterar = {
  params: paramsComId,
  // Sem `ativo` e sem nenhum campo de identidade: só o que a API pode
  // mudar. Corpo vazio é aceito pelo schema e recusado pelo serviço com
  // GRUPO_SEM_ALTERACAO — a regra de "algo precisa mudar" é de negócio.
  body: z.strictObject({
    nome: nome.optional(),
    descricao: z.union([descricao, z.null()]).optional(),
  }),
};

// Nenhum dado de negócio chega por aqui: strictObject({}) aceita corpo
// ausente ({} sintético de validar() quando req.body é undefined) e {}
// explícito, e rejeita com 400 VALIDACAO qualquer campo informado — a
// mesma proteção contra fonte de autoridade forjada (ativo, empresaId,
// isMaster, perfil, atorId, criadoPor) já aplicada em criar()/alterar(),
// agora também nestas duas rotas (correção pós-auditoria da Subetapa 3M).
const semCorpo = z.strictObject({});

const inativar = { params: paramsComId, body: semCorpo };
const reativar = { params: paramsComId, body: semCorpo };

module.exports = { criar, listar, buscar, alterar, inativar, reativar };
