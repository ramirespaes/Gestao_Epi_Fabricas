'use strict';

const { z } = require('zod');
const {
  idParametro, booleanoQuery, paginacaoQuery, textoCurto, LIMITES,
} = require('./campos.schema');
const materialTamanhoRepo = require('../repositories/material-tamanho.repository');

/**
 * Schemas das rotas de materiais (Bloco 9, Etapa A). Só estrutura e
 * formato, sem contexto: não consultam banco, não conhecem empresa nem
 * autorização, e não decidem nada de negócio — existência do material e
 * validação de domínio (ex.: prazo de uso positivo) são do serviço.
 *
 * `strictObject` em todo corpo rejeita qualquer campo não declarado com
 * 400 antes do controller — é assim que `id`, `empresaId`, `ativo` e
 * `criadoEm` ficam fora do alcance da API. `ativo` não é aceito em corpo
 * nenhum: inativar e reativar têm rotas próprias, mesmo padrão de
 * grupo-acesso.schema.js.
 *
 * Campos opcionais (`tipo`, `fabricante`) aceitam `null` explícito, que o
 * serviço interpreta como "limpar o campo"; ausente significa "não mexer"
 * em alterar() — mesmo contrato de `descricao` em grupo-acesso.schema.js.
 *
 * O material não tem CA (E10): o CA e a validade são do lote, na entrada.
 * `caNumero` e `caValidade` ficam fora dos dois corpos e recebem 400; as
 * colunas antigas continuam no banco só como histórico.
 *
 * O prazo de uso é obrigatório no cadastro e, na edição, pode mudar mas
 * não pode ser apagado: não aceita `null`. `exigeTamanho` segue a mesma
 * regra: o material novo sempre diz se usa tamanho.
 *
 * `oculosComGrau` aceita true, false ou null. Se ele é obrigatório ou
 * proibido depende do tipo do material, e quem decide isso é o serviço.
 */

// materiais.nome VARCHAR(150), tipo/fabricante VARCHAR(100), unidade
// VARCHAR(20) — mesmos tetos da migration 007.
const NOME_MAXIMO = 150;
const TIPO_MAXIMO = 100;
const FABRICANTE_MAXIMO = 100;
const UNIDADE_MAXIMA = 20;
const BUSCA_MAXIMA = 100;
// Parte C2 (migration 039): categoria/codigo_interno VARCHAR(30), descricao
// TEXT com teto de 500 na aplicação e no CHECK do banco.
const CATEGORIA_MAXIMA = 30;
const CODIGO_INTERNO_MAXIMO = 30;
const DESCRICAO_MAXIMA = 500;
// 12G-8 (migration 071): descrição do tipo "Outros", VARCHAR(100).
const TIPO_DESCRICAO_MAXIMA = 100;

const nome = textoCurto(NOME_MAXIMO, 'NOME_INVALIDO', 'Nome do material inválido');
const tipo = textoCurto(TIPO_MAXIMO, 'TIPO_INVALIDO', 'Tipo inválido');
const tipoDescricao = textoCurto(TIPO_DESCRICAO_MAXIMA, 'TIPO_DESCRICAO_INVALIDA', 'Descrição do tipo inválida');
const fabricante = textoCurto(FABRICANTE_MAXIMO, 'FABRICANTE_INVALIDO', 'Fabricante inválido');
const unidade = textoCurto(UNIDADE_MAXIMA, 'UNIDADE_INVALIDA', 'Unidade inválida');
const busca = textoCurto(BUSCA_MAXIMA, 'BUSCA_INVALIDA', 'Termo de busca inválido');
const categoria = textoCurto(CATEGORIA_MAXIMA, 'CATEGORIA_INVALIDA', 'Categoria inválida');
const codigoInterno = textoCurto(CODIGO_INTERNO_MAXIMO, 'CODIGO_INTERNO_INVALIDO', 'Código interno inválido');
const descricao = textoCurto(DESCRICAO_MAXIMA, 'DESCRICAO_INVALIDA', 'Descrição inválida');

// prazo_uso_dias e estoque_minimo: number nativo do Zod já produz
// TAMANHO_MINIMO/TIPO_INVALIDO/CAMPO_OBRIGATORIO em validar.js sem
// precisar de transform custom. .max(INTEGER_MAXIMO): as duas colunas são
// INTEGER (int4) no banco (migration 007) — sem este teto, um valor maior
// chegaria ao PostgreSQL e estouraria como erro não tratado (500) em vez
// de um 400 de validação (correção pós-auditoria de 23/09/2026).
const prazoUsoDias = z.number().int().positive().max(LIMITES.INTEGER_MAXIMO);
const estoqueMinimo = z.number().int().nonnegative().max(LIMITES.INTEGER_MAXIMO);
const exigeTamanho = z.boolean();
const oculosComGrau = z.boolean().nullable();

// 12G-8 (migration 070): grade de tamanhos, na ordem de exibição. Cada tamanho
// no mesmo formato do tamanho do lote; nenhum se repete, sem diferenciar
// maiúsculas. [] apaga a grade (o material volta a não ter grade).
const tamanhos = z.array(textoCurto(materialTamanhoRepo.TAMANHO_MAXIMO, 'TAMANHO_INVALIDO', 'Tamanho inválido'))
  .max(materialTamanhoRepo.LIMITE_GRADE)
  .superRefine((lista, ctx) => {
    const vistos = new Set();
    lista.forEach((tamanho, indice) => {
      if (typeof tamanho !== 'string') return;
      const chave = tamanho.toUpperCase();
      if (vistos.has(chave)) {
        ctx.addIssue({ code: 'custom', path: [indice], message: 'Tamanho repetido na grade', params: { codigo: 'TAMANHO_REPETIDO' } });
      }
      vistos.add(chave);
    });
  });

const paramsComId = z.strictObject({ id: idParametro });

const criar = {
  body: z.strictObject({
    nome,
    categoria: categoria.nullable().optional(),
    codigoInterno: codigoInterno.nullable().optional(),
    descricao: descricao.nullable().optional(),
    tipo: tipo.nullable().optional(),
    tipoDescricao: tipoDescricao.nullable().optional(),
    fabricante: fabricante.nullable().optional(),
    prazoUsoDias,
    exigeTamanho,
    oculosComGrau: oculosComGrau.optional(),
    unidade: unidade.optional(),
    estoqueMinimo: estoqueMinimo.optional(),
    tamanhos: tamanhos.optional(),
  }),
};

const listar = {
  query: z.strictObject({
    ...paginacaoQuery,
    // Ausente lista ativos E inativos; true/false filtram explicitamente.
    ativo: booleanoQuery.optional(),
    busca: busca.optional(),
  }),
};

const buscar = { params: paramsComId };

// `unidade` NÃO é aceita na edição (ajuste pós-melhoria C2, 25/09/2026):
// trocar a unidade de controle mudaria o sentido dos saldos existentes
// ("par" → "unidade"). Fica fora do strictObject, como `ativo`: qualquer
// PATCH com `unidade` é 400 VALIDACAO (CAMPO_NAO_PERMITIDO). Troca
// controlada, com regra de integridade, é melhoria futura.
const alterar = {
  params: paramsComId,
  body: z.strictObject({
    nome: nome.optional(),
    categoria: categoria.nullable().optional(),
    codigoInterno: codigoInterno.nullable().optional(),
    descricao: descricao.nullable().optional(),
    tipo: tipo.nullable().optional(),
    tipoDescricao: tipoDescricao.nullable().optional(),
    fabricante: fabricante.nullable().optional(),
    prazoUsoDias: prazoUsoDias.optional(),
    exigeTamanho: exigeTamanho.optional(),
    oculosComGrau: oculosComGrau.optional(),
    estoqueMinimo: estoqueMinimo.optional(),
    tamanhos: tamanhos.optional(),
  }),
};

// Sem dado de negócio nenhum: mesma proteção contra fonte de autoridade
// forjada (ativo, empresaId, atorId) já aplicada em criar()/alterar().
const semCorpo = z.strictObject({});

const inativar = { params: paramsComId, body: semCorpo };
const reativar = { params: paramsComId, body: semCorpo };

// Mínimos por tamanho (12D-2, migration 067). O tamanho vai no caminho, com o
// mesmo formato dos lotes (aparado, até 20 caracteres, sem controle); a empresa
// nunca vem do cliente. O mínimo próprio 0 é válido: significa "este tamanho
// não tem mínimo", e é diferente de remover a sobrescrita (voltar ao padrão).
const TAMANHO_ESTOQUE_MAXIMO = 20;
const tamanhoDoMinimo = textoCurto(TAMANHO_ESTOQUE_MAXIMO, 'TAMANHO_INVALIDO', 'Tamanho inválido');
const paramsDoMinimo = z.strictObject({ id: idParametro, tamanho: tamanhoDoMinimo });

const minimos = { params: paramsComId };
const minimo = { params: paramsDoMinimo };
const definirMinimo = { params: paramsDoMinimo, body: z.strictObject({ minimo: estoqueMinimo }) };
const removerMinimo = { params: paramsDoMinimo, body: semCorpo };

module.exports = {
  criar, listar, buscar, alterar, inativar, reativar, minimos, minimo, definirMinimo, removerMinimo,
};
