'use strict';

const { z } = require('zod');
const { idParametro, codigoCatalogo } = require('./campos.schema');

/**
 * Schemas HTTP das permissões de grupo (Bloco 8, Incremento 8, Etapa 5A,
 * Subetapa 3N). Só estrutura e formato, sem contexto: não consultam
 * banco, não conhecem empresa, ator ou autoridade administrativa, e não
 * decidem nada de negócio — existência do grupo, existência e estado da
 * ação (ativa, modo NENHUMA/ALTERNATIVA/OBRIGATORIA) e a composição
 * parcial do tri-state são do serviço já aprovado na Subetapa 3K
 * (grupo-permissao.service.js), inalterado em suas quatro operações de
 * leitura/escrita.
 *
 * O QUE NÃO ENTRA POR AQUI: `strictObject` nos corpos rejeita, com 400,
 * qualquer campo não declarado — em particular `empresaId`, `atorId`,
 * `usuarioId`, `isMaster`, `perfil` e `criadoPor` nunca alcançam o
 * serviço por esta via, mesma proteção já aplicada em
 * grupo-acesso.schema.js desde a Subetapa 3M.
 *
 * TRI-STATE PRESERVADO NO SCHEMA:
 *   - nas quatro operações de recurso, cada campo é `boolean|null` e
 *     OPCIONAL: ausente é estruturalmente diferente de `null` — Zod não
 *     inclui a chave no resultado quando o corpo não a envia, e é assim
 *     que o serviço distingue "não mexer" (ausente) de "herdar do
 *     perfil" (`null`) de "conceder"/"negar" (`true`/`false`). Corpo
 *     `{}` é estruturalmente válido aqui: é o serviço, não o schema,
 *     quem recusa "nenhuma operação informada" com 400
 *     GRUPO_PERMISSAO_SEM_ALTERACAO — regra de negócio, não de formato;
 *   - em ação, `permitido` é o mesmo `boolean|null`, mas OBRIGATÓRIO: a
 *     rota configura uma única ação por chamada, então não existe
 *     "operação ausente" a preservar, e omitir a chave é 400
 *     CAMPO_OBRIGATORIO, nunca interpretado como "não mexer".
 *
 * `recurso` (identificador de página/módulo) e `acaoCodigo` (código do
 * catálogo `acoes`) usam exatamente os mesmos formatos já aplicados por
 * grupo-permissao.repository.js e permissao.repository.js
 * (FORMATO_RECURSO / FORMATO_ACAO_CODIGO) — o schema só valida formato;
 * existência e estado continuam sendo o serviço quem decide, lendo o
 * catálogo real a cada chamada.
 */

// Mesmo formato de grupo-permissao.repository.js/permissao.repository.js:
// identificador de página/módulo do frontend ('materials',
// 'stockValidity'), não o formato maiúsculo do catálogo de ações.
const FORMATO_RECURSO = /^[a-zA-Z][a-zA-Z0-9_]{0,59}$/;

const paramsGrupo = z.strictObject({ id: idParametro });

const paramsRecurso = z.strictObject({
  id: idParametro,
  recurso: z.string().regex(FORMATO_RECURSO),
});

// acoes.codigo: VARCHAR(60) (migration 003), mesmo formato maiúsculo já
// usado por permissao.repository.js e grupo-permissao.repository.js.
const paramsAcao = z.strictObject({
  id: idParametro,
  acaoCodigo: codigoCatalogo(60, 'ACAO_CODIGO_INVALIDO', 'Código de ação inválido'),
});

const triState = z.boolean().nullable();

const listarRecursos = { params: paramsGrupo };
const listarAcoes = { params: paramsGrupo };

const configurarRecurso = {
  params: paramsRecurso,
  body: z.strictObject({
    podeVisualizar: triState.optional(),
    podeCriar: triState.optional(),
    podeEditar: triState.optional(),
    podeExcluir: triState.optional(),
  }),
};

const configurarAcao = {
  params: paramsAcao,
  body: z.strictObject({ permitido: triState }),
};

module.exports = { listarRecursos, listarAcoes, configurarRecurso, configurarAcao };
