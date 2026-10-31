'use strict';

/**
 * Eventos do histórico de um funcionário lidos de logs_auditoria (só leitura; a auditoria não muda): tipos GHE (pacote E),
 * SITUAÇÃO (pacote F) e CADASTRAL (pacote G), estes dois mais abaixo.
 *
 * Filtro sempre por empresa e referência (o id do funcionário, como texto) e por ações conhecidas; nada de outro
 * funcionário, de outra empresa ou de outra ação com a mesma referência. Devolve as colunas necessárias, nunca ip,
 * dispositivo, perfil nem o JSON inteiro: só os campos de GHE e a origem são extraídos no SQL.
 *
 * Eventos de GHE:
 *   - FUNCIONARIO_GHE_ALTERADO (desde o S3): GHE anterior e novo como { id, codigo, descricao } da época;
 *   - FUNCIONARIO_CRIADO com a chave grupoHomogeneoId (cadastro ou importação): registro inicial, só o id;
 *   - FUNCIONARIO_ALTERADO em que grupoHomogeneoId mudou: só os ids. Desde o S3 a troca grava os dois eventos na MESMA
 *     transação; o ALTERADO só fica de fora quando há o GHE_ALTERADO correspondente: mesma empresa, referência, instante
 *     (now() da transação), usuário, gravado depois (id maior) e com os MESMOS GHE anterior e novo. Assim um ALTERADO
 *     legado (antes do S3) ou qualquer evento que não feche essa correlação inteira continua aparecendo.
 * Ordem: criado_em DESC, id DESC. Atende-se pelo índice (empresa_id, criado_em DESC, id DESC) da 079.
 */

const ACOES = ['FUNCIONARIO_GHE_ALTERADO', 'FUNCIONARIO_CRIADO', 'FUNCIONARIO_ALTERADO'];
const LIMITE_MAXIMO = 100;

// Período (pacote H): dias de São Paulo, inclusivos, como em relatorio-auditoria. Intervalo semiaberto sobre criado_em
// (início do dia inicial <= evento < início do dia seguinte ao final), com o fuso real (inclui o antigo horário de verão).
// Vale no filtro comum, então a contagem e a página veem os mesmos eventos. Cada limite é opcional.
const DATA_FORMATO = /^\d{4}-\d{2}-\d{2}$/;
const PERIODO = (de, ate) => `
    AND (${de}::date IS NULL OR l.criado_em >= (${de}::date)::timestamp AT TIME ZONE 'America/Sao_Paulo')
    AND (${ate}::date IS NULL OR l.criado_em < ((${ate}::date) + 1)::timestamp AT TIME ZONE 'America/Sao_Paulo')`;

function periodo({ de = null, ate = null } = {}) {
  for (const data of [de, ate]) {
    if (data !== null && (typeof data !== 'string' || !DATA_FORMATO.test(data))) throw new TypeError('período inválido');
  }
  return [de, ate];
}

const FILTRO_GHE = `
  WHERE l.empresa_id = $1 AND l.referencia = $2 AND l.acao = ANY($3::text[])
    AND (
      (l.acao = 'FUNCIONARIO_GHE_ALTERADO' AND l.dados_anteriores ? 'grupoHomogeneo' AND l.dados_novos ? 'grupoHomogeneo')
      OR (l.acao = 'FUNCIONARIO_CRIADO' AND l.dados_novos ? 'grupoHomogeneoId')
      OR (l.acao = 'FUNCIONARIO_ALTERADO'
          AND l.dados_anteriores ? 'grupoHomogeneoId' AND l.dados_novos ? 'grupoHomogeneoId'
          AND (l.dados_anteriores->>'grupoHomogeneoId') IS DISTINCT FROM (l.dados_novos->>'grupoHomogeneoId')
          AND NOT EXISTS (
            SELECT 1 FROM logs_auditoria g
             WHERE g.empresa_id = l.empresa_id AND g.referencia = l.referencia AND g.acao = 'FUNCIONARIO_GHE_ALTERADO'
               AND g.criado_em = l.criado_em AND g.id > l.id AND g.usuario_id IS NOT DISTINCT FROM l.usuario_id
               AND (g.dados_anteriores->'grupoHomogeneo'->>'id') IS NOT DISTINCT FROM (l.dados_anteriores->>'grupoHomogeneoId')
               AND (g.dados_novos->'grupoHomogeneo'->>'id') IS NOT DISTINCT FROM (l.dados_novos->>'grupoHomogeneoId')))
    )${PERIODO('$4', '$5')}`;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

function parametros(empresaId, funcionarioId, filtro) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  return [empresaId, String(funcionarioId), ACOES, ...periodo(filtro)];
}

/** Uma página dos eventos de GHE, com o usuário responsável da empresa (nome atual) quando existe. */
async function listarGhe(executor, empresaId, funcionarioId, { pagina, limite, ...filtro }) {
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  const { rows } = await executor.query(
    `SELECT l.id, l.acao, l.criado_em, l.contexto->>'origem' AS origem,
            l.dados_anteriores->'grupoHomogeneo' AS ghe_anterior, l.dados_novos->'grupoHomogeneo' AS ghe_novo,
            l.dados_anteriores->'grupoHomogeneoId' AS ghe_id_anterior, l.dados_novos->'grupoHomogeneoId' AS ghe_id_novo,
            u.id AS responsavel_id, u.nome AS responsavel_nome
       FROM logs_auditoria l
       LEFT JOIN usuarios u ON u.empresa_id = l.empresa_id AND u.id = l.usuario_id
      ${FILTRO_GHE}
      ORDER BY l.criado_em DESC, l.id DESC
      LIMIT $6 OFFSET $7`,
    [...parametros(empresaId, funcionarioId, filtro), limite, (pagina - 1) * limite],
  );
  return rows.map((l) => ({
    id: String(l.id),
    acao: l.acao,
    ocorridoEm: l.criado_em,
    origem: l.origem,
    gheAnterior: l.ghe_anterior,
    gheNovo: l.ghe_novo,
    gheIdAnterior: l.ghe_id_anterior,
    gheIdNovo: l.ghe_id_novo,
    responsavel: l.responsavel_id === null ? null : { id: l.responsavel_id, nome: l.responsavel_nome },
  }));
}

async function contarGhe(executor, empresaId, funcionarioId, filtro) {
  const { rows } = await executor.query(
    `SELECT count(*)::int AS total FROM logs_auditoria l ${FILTRO_GHE}`,
    parametros(empresaId, funcionarioId, filtro),
  );
  return rows[0].total;
}

// ── Pacote F: situação ──────────────────────────────────────────────
// Eventos de situação:
//   - FUNCIONARIO_SITUACAO_ALTERADA (desde o S2): { situacao } anterior e nova;
//   - FUNCIONARIO_CRIADO com a chave `ativo` (cadastro ou importação): situação inicial;
//   - FUNCIONARIO_INATIVADO / FUNCIONARIO_REATIVADO, com `ativo` mudando: antes do S2 eram o único registro. Desde o S2 vêm
//     DEPOIS do SITUACAO_ALTERADA na mesma transação; só ficam de fora quando há o SITUACAO_ALTERADA correspondente: mesma
//     empresa, referência, instante e usuário, id menor e a MESMA transição (o legado só conhece ATIVO/INATIVO).
// A data efetiva vem do histórico próprio, ligada pelo `historicoId` do contexto da auditoria; evento sem essa ligação (legado) não tem data.
// FUNCIONARIO_ALTERADO nunca mudou a situação (o PATCH jamais aceitou ativo/situacao): não é fonte.
const ACOES_SITUACAO = ['FUNCIONARIO_SITUACAO_ALTERADA', 'FUNCIONARIO_CRIADO', 'FUNCIONARIO_INATIVADO', 'FUNCIONARIO_REATIVADO'];
const SITUACAO_DO_ATIVO = (expr) => `CASE ${expr} WHEN 'true' THEN 'ATIVO' WHEN 'false' THEN 'INATIVO' END`;

const FILTRO_SITUACAO = `
  WHERE l.empresa_id = $1 AND l.referencia = $2 AND l.acao = ANY($3::text[])
    AND (
      (l.acao = 'FUNCIONARIO_SITUACAO_ALTERADA' AND l.dados_anteriores ? 'situacao' AND l.dados_novos ? 'situacao')
      OR (l.acao = 'FUNCIONARIO_CRIADO' AND l.dados_novos ? 'ativo')
      OR (l.acao IN ('FUNCIONARIO_INATIVADO', 'FUNCIONARIO_REATIVADO')
          AND l.dados_anteriores ? 'ativo' AND l.dados_novos ? 'ativo'
          AND (l.dados_anteriores->>'ativo') IS DISTINCT FROM (l.dados_novos->>'ativo')
          AND NOT EXISTS (
            SELECT 1 FROM logs_auditoria s
             WHERE s.empresa_id = l.empresa_id AND s.referencia = l.referencia AND s.acao = 'FUNCIONARIO_SITUACAO_ALTERADA'
               AND s.criado_em = l.criado_em AND s.id < l.id AND s.usuario_id IS NOT DISTINCT FROM l.usuario_id
               AND (s.dados_anteriores->>'situacao') = ${SITUACAO_DO_ATIVO("l.dados_anteriores->>'ativo'")}
               AND (s.dados_novos->>'situacao') = ${SITUACAO_DO_ATIVO("l.dados_novos->>'ativo'")}
               AND (s.dados_novos->>'situacao') = CASE l.acao WHEN 'FUNCIONARIO_INATIVADO' THEN 'INATIVO' ELSE 'ATIVO' END))
    )${PERIODO('$4', '$5')}`;

function parametrosSituacao(empresaId, funcionarioId, filtro) {
  const [e, f, , de, ate] = parametros(empresaId, funcionarioId, filtro);
  return [e, f, ACOES_SITUACAO, de, ate];
}

/** Uma página dos eventos de situação, com o usuário responsável da empresa (nome atual) quando existe. */
async function listarSituacao(executor, empresaId, funcionarioId, { pagina, limite, ...filtro }) {
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  const { rows } = await executor.query(
    `SELECT l.id, l.acao, l.criado_em, l.contexto->>'origem' AS origem,
            l.dados_anteriores->>'situacao' AS situacao_anterior, l.dados_novos->>'situacao' AS situacao_nova,
            ${SITUACAO_DO_ATIVO("l.dados_anteriores->>'ativo'")} AS situacao_do_ativo_anterior,
            ${SITUACAO_DO_ATIVO("l.dados_novos->>'ativo'")} AS situacao_do_ativo_nova,
            to_char(h.data_efetiva, 'YYYY-MM-DD') AS data_efetiva,
            u.id AS responsavel_id, u.nome AS responsavel_nome
       FROM logs_auditoria l
       LEFT JOIN usuarios u ON u.empresa_id = l.empresa_id AND u.id = l.usuario_id
       LEFT JOIN funcionario_situacoes h
              ON h.empresa_id = l.empresa_id AND h.funcionario_id::text = l.referencia
             AND l.acao = 'FUNCIONARIO_SITUACAO_ALTERADA' AND h.id::text = l.contexto->>'historicoId'
      ${FILTRO_SITUACAO}
      ORDER BY l.criado_em DESC, l.id DESC
      LIMIT $6 OFFSET $7`,
    [...parametrosSituacao(empresaId, funcionarioId, filtro), limite, (pagina - 1) * limite],
  );
  return rows.map((l) => {
    const atual = l.acao === 'FUNCIONARIO_SITUACAO_ALTERADA';
    return {
      id: String(l.id),
      acao: l.acao,
      ocorridoEm: l.criado_em,
      origem: l.origem,
      situacaoAnterior: atual ? l.situacao_anterior : l.situacao_do_ativo_anterior,
      situacaoNova: atual ? l.situacao_nova : l.situacao_do_ativo_nova,
      dataEfetiva: l.data_efetiva,
      responsavel: l.responsavel_id === null ? null : { id: l.responsavel_id, nome: l.responsavel_nome },
    };
  });
}

async function contarSituacao(executor, empresaId, funcionarioId, filtro) {
  const { rows } = await executor.query(
    `SELECT count(*)::int AS total FROM logs_auditoria l ${FILTRO_SITUACAO}`,
    parametrosSituacao(empresaId, funcionarioId, filtro),
  );
  return rows[0].total;
}

// ── Pacote G: alterações cadastrais ─────────────────────────────────
// Só os campos de CAMPOS_CADASTRAIS (nessa ordem), comparados como texto (->>), igual ao serviço:
//   - FUNCIONARIO_CRIADO (cadastro ou importação): elegível se algum campo veio com valor não nulo;
//   - FUNCIONARIO_ALTERADO: elegível se algum campo existe NOS DOIS lados e mudou. O PATCH grava o evento sempre que um
//     campo é informado, então a mudança é medida aqui; chave ausente num lado (registro antigo) não conta.
// O total conta os mesmos eventos que a página lista. Do JSON só saem os campos da lista.
const ACOES_CADASTRAL = ['FUNCIONARIO_CRIADO', 'FUNCIONARIO_ALTERADO'];
const CAMPOS_CADASTRAIS = Object.freeze(['nome', 'matricula', 'setor', 'funcao', 'dataAdmissao']);

const FILTRO_CADASTRAL = `
  WHERE l.empresa_id = $1 AND l.referencia = $2 AND l.acao = ANY($3::text[])
    AND (
      (l.acao = 'FUNCIONARIO_CRIADO' AND jsonb_typeof(l.dados_novos) = 'object'
        AND EXISTS (SELECT 1 FROM unnest($4::text[]) k WHERE (l.dados_novos->>k) IS NOT NULL))
      OR (l.acao = 'FUNCIONARIO_ALTERADO'
        AND jsonb_typeof(l.dados_anteriores) = 'object' AND jsonb_typeof(l.dados_novos) = 'object'
        AND EXISTS (SELECT 1 FROM unnest($4::text[]) k
                     WHERE l.dados_anteriores ? k AND l.dados_novos ? k
                       AND (l.dados_anteriores->>k) IS DISTINCT FROM (l.dados_novos->>k)))
    )${PERIODO('$5', '$6')}`;

const SUBCONJUNTO = (coluna) => `(SELECT jsonb_object_agg(k, ${coluna}->>k) FROM unnest($4::text[]) k
   WHERE jsonb_typeof(${coluna}) = 'object' AND ${coluna} ? k)`;

function parametrosCadastral(empresaId, funcionarioId, filtro) {
  const [e, f, , de, ate] = parametros(empresaId, funcionarioId, filtro);
  return [e, f, ACOES_CADASTRAL, CAMPOS_CADASTRAIS, de, ate];
}

/** Uma página dos eventos cadastrais: só os campos da lista, como texto, com a presença de cada chave preservada. */
async function listarCadastral(executor, empresaId, funcionarioId, { pagina, limite, ...filtro }) {
  exigirId(pagina, 'página');
  if (!Number.isInteger(limite) || limite < 1 || limite > LIMITE_MAXIMO) throw new TypeError('limite inválido');
  const { rows } = await executor.query(
    `SELECT l.id, l.acao, l.criado_em, l.contexto->>'origem' AS origem,
            ${SUBCONJUNTO('l.dados_anteriores')} AS anteriores, ${SUBCONJUNTO('l.dados_novos')} AS novos,
            u.id AS responsavel_id, u.nome AS responsavel_nome
       FROM logs_auditoria l
       LEFT JOIN usuarios u ON u.empresa_id = l.empresa_id AND u.id = l.usuario_id
      ${FILTRO_CADASTRAL}
      ORDER BY l.criado_em DESC, l.id DESC
      LIMIT $7 OFFSET $8`,
    [...parametrosCadastral(empresaId, funcionarioId, filtro), limite, (pagina - 1) * limite],
  );
  return rows.map((l) => ({
    id: String(l.id),
    acao: l.acao,
    ocorridoEm: l.criado_em,
    origem: l.origem,
    anteriores: l.anteriores,
    novos: l.novos,
    responsavel: l.responsavel_id === null ? null : { id: l.responsavel_id, nome: l.responsavel_nome },
  }));
}

async function contarCadastral(executor, empresaId, funcionarioId, filtro) {
  const { rows } = await executor.query(
    `SELECT count(*)::int AS total FROM logs_auditoria l ${FILTRO_CADASTRAL}`,
    parametrosCadastral(empresaId, funcionarioId, filtro),
  );
  return rows[0].total;
}

module.exports = {
  listarGhe, contarGhe, listarSituacao, contarSituacao, listarCadastral, contarCadastral,
  ACOES, ACOES_SITUACAO, ACOES_CADASTRAL, CAMPOS_CADASTRAIS,
};
