'use strict';

const { z } = require('zod');
const { idParametro } = require('./campos.schema');

/**
 * Schemas HTTP de vinculação de usuários aos grupos de acesso (Bloco 8,
 * Incremento 8, Etapa 5A, Subetapa 3O). Só estrutura e formato, sem
 * contexto: não consultam banco, não conhecem empresa, ator ou
 * autoridade administrativa, e não decidem nada de negócio — existência
 * de usuário e grupo, unicidade do grupo principal, a proibição de
 * autovínculo e as recusas de MASTER/inativo/grupo inativo são do
 * serviço já aprovado na Subetapa 3L (grupo-usuario.service.js),
 * inalterado em suas três operações.
 *
 * O QUE NÃO ENTRA POR AQUI: `strictObject` nos corpos rejeita, com 400,
 * qualquer campo — em particular `empresaId`, `atorId`, `usuarioId`,
 * `isMaster` e `perfil` nunca alcançam o serviço por um corpo forjado.
 * Nenhuma das duas rotas de escrita (vincular/desvincular) recebe dado
 * de negócio pelo corpo. `semCorpo` aceita corpo ausente ou `{}` e
 * rejeita qualquer campo informado — mesma proteção já aplicada em
 * inativar/reativar desde o Ajuste Final da Subetapa 3M, adotada aqui
 * desde a primeira versão da rota, sem esperar por uma correção
 * posterior.
 *
 * VINCULAR EXIGE GRUPO; DESVINCULAR NÃO (correção pós-auditoria da
 * Subetapa 3O): vincular() do serviço da 3L recebe um grupo de destino
 * (`grupoId`), então `paramsGrupoUsuario` (id do grupo + id do usuário)
 * é o contrato certo para essa rota. desvincular() NÃO recebe grupoId
 * — ela sempre remove o vínculo ATUAL do usuário, seja ele qual for.
 * Colocar um `:id` de grupo na URL de desvincular era estruturalmente
 * enganoso (sugeria uma dependência que o serviço não tem, e podia
 * divergir do vínculo real sem que o schema pudesse detectar isso).
 * Por isso `desvincular` usa `paramsUsuario` (só o usuário), sem
 * nenhuma referência a grupo — a rota correspondente
 * (grupo-usuario.routes.js) deixou de viver sob `/grupos-acesso/:id`.
 */

const paramsGrupo = z.strictObject({ id: idParametro });

const paramsGrupoUsuario = z.strictObject({ id: idParametro, usuarioId: idParametro });

const paramsUsuario = z.strictObject({ usuarioId: idParametro });

const semCorpo = z.strictObject({});

const listar = { params: paramsGrupo };
const vincular = { params: paramsGrupoUsuario, body: semCorpo };
const desvincular = { params: paramsUsuario, body: semCorpo };

module.exports = { listar, vincular, desvincular };
