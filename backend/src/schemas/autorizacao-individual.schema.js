'use strict';

const { z } = require('zod');
const { idParametro, idCorpo, codigoCatalogo, textoCurto } = require('./campos.schema');

/**
 * Schemas HTTP de autorizações individuais de ação (Bloco 8, Incremento
 * 8, Etapa 5A, Subetapa 3P). Só estrutura e formato, sem contexto: não
 * consultam banco, não conhecem empresa, ator ou autoridade
 * administrativa, e não decidem nada de negócio — quem pode conceder,
 * quem pode delegar (pode_delegar da ORIGEM, nunca do chamador), a
 * validade da origem, o modo da ação (NENHUMA/ALTERNATIVA/OBRIGATORIA)
 * e a auditoria são inteiramente do serviço já aprovado na Subetapa 3I
 * (autorizacao-individual.service.js), inalterado em suas três
 * operações (concederDireta, delegar, revogar).
 *
 * O QUE NÃO ENTRA POR AQUI: `strictObject` em ambos os corpos rejeita,
 * com 400, qualquer campo não declarado — em particular `empresaId`,
 * `atorId`, `concedidoPor`, `autorizadoPor`, `isMaster` e `perfil`
 * nunca alcançam o serviço por um corpo forjado. `origemId` É aceito,
 * mas só no ramo DELEGADA, e não é um "campo interno de auditoria": é
 * o insumo de negócio da delegação, e o serviço da 3I sempre o
 * revalida por inteiro (pertence ao próprio chamador, tem
 * pode_delegar = true, é da mesma ação, mesma empresa) antes de
 * confiar nele — um origemId forjado nunca fabrica nem substitui a
 * cadeia legítima, só é rejeitado.
 *
 * UM ÚNICO ENDPOINT DE CRIAÇÃO, DISCRIMINADO POR `tipo`: concessão
 * direta (`tipo: 'DIRETA'`, exige `acaoCodigo`) e delegação
 * (`tipo: 'DELEGADA'`, exige `origemId` — a ação da autorização nasce
 * da origem, nunca é informada pelo chamador) criam a mesma espécie de
 * registro, então dividem UM endpoint em vez de dois quase idênticos —
 * mesmo raciocínio que já evitou uma rota separada de "transferir" na
 * Subetapa 3O. `z.discriminatedUnion('tipo', ...)` garante que os dois
 * ramos nunca se misturem: informar `origemId` com `tipo: 'DIRETA'` (ou
 * `acaoCodigo` com `tipo: 'DELEGADA'`) é 400 CAMPO_NAO_PERMITIDO, não
 * uma composição aceita silenciosamente.
 *
 * NÃO HÁ SCHEMA DE CONSULTA/LISTAGEM NESTA SUBETAPA: o serviço da 3I
 * não expõe nenhuma função de leitura administrativa (só as três de
 * escrita) — a própria autorização desta rodada condiciona expor
 * consulta a "caso já exista serviço correspondente", e não existe.
 * Inventar uma aqui seria reconstruir lógica de negócio fora do
 * escopo autorizado.
 *
 * `idCorpo` (novo em campos.schema.js): `usuarioId` e `origemId` chegam
 * no CORPO da requisição (não na URL), então usam o validador de
 * identificador para número, não a variante de string de
 * `idParametro` usada em `params.id` — mesmo teto (int4) e mesmo
 * código de erro `ID_INVALIDO`.
 */

// usuario_autorizacoes.motivo é TEXT (sem limite no banco, migration
// 019); o teto aqui é proteção de entrada da API, mesmo padrão de
// `descricao` em grupo-acesso.schema.js.
const MOTIVO_MAXIMO = 500;
const motivo = textoCurto(MOTIVO_MAXIMO, 'MOTIVO_INVALIDO', 'Motivo inválido');
const motivoOpcional = z.union([motivo, z.null()]).optional();

const paramsAutorizacao = z.strictObject({ id: idParametro });

const concessaoDireta = z.strictObject({
  tipo: z.literal('DIRETA'),
  usuarioId: idCorpo,
  // acoes.codigo: VARCHAR(60) (migration 003), mesmo formato maiúsculo
  // já usado por permissao.repository.js e autorizacao-individual.repository.js.
  acaoCodigo: codigoCatalogo(60, 'ACAO_CODIGO_INVALIDO', 'Código de ação inválido'),
  podeDelegar: z.boolean().optional(),
  motivo: motivoOpcional,
});

const concessaoDelegada = z.strictObject({
  tipo: z.literal('DELEGADA'),
  usuarioId: idCorpo,
  origemId: idCorpo,
  podeDelegar: z.boolean().optional(),
  motivo: motivoOpcional,
});

const criar = {
  body: z.discriminatedUnion('tipo', [concessaoDireta, concessaoDelegada]),
};

const revogar = {
  params: paramsAutorizacao,
  // Só `motivo` — a razão da revogação, opcional. Nenhum outro campo:
  // não é possível informar quem revoga, qual empresa, nem escolher
  // "revogar em cascata" (a cascata é sempre automática, pela FK da
  // migration 023, nunca uma opção do chamador).
  body: z.strictObject({ motivo: motivoOpcional }),
};

module.exports = { criar, revogar };
