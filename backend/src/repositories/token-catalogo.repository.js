'use strict';

const sqlCatalogo = require('./sql/catalogo-token');
const { normalizarIdGrande } = require('../utils/identificador-grande');

/**
 * Leituras do catálogo do Atendimento Token (Etapa E). Só leitura, sempre por empresa, com o GHE vindo do cadastro do funcionário do
 * atendimento (nunca do cliente). Nenhuma coluna de estoque é lida para a resposta: o saldo não filtra nem aparece.
 * Executor por parâmetro; nenhuma regra de negócio além da seleção SQL.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

const AUTORIZADO = sqlCatalogo.autorizadoNoCatalogo({ material: 'm', ghe: '$2' });
const TAMANHOS = sqlCatalogo.tamanhosDoMaterial({ material: 'm' });

/** GHE ATUAL do funcionário e se ele está ativo (`null` em ambos quando não há GHE). */
async function buscarGheDoFuncionario(executor, { empresaId, funcionarioId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');
  const { rows } = await executor.query(
    `SELECT f.grupo_homogeneo_id AS ghe_id, g.ativo AS ghe_ativo
       FROM funcionarios f
       LEFT JOIN grupos_homogeneos_exposicao g ON g.empresa_id = f.empresa_id AND g.id = f.grupo_homogeneo_id
      WHERE f.empresa_id = $1 AND f.id = $2`,
    [empresaId, funcionarioId],
  );
  return rows[0] ?? null;
}

/**
 * Materiais físicos solicitáveis do GHE: ativos, classificados quanto a tamanho (exige_tamanho não nulo), autorizados pelo GHE
 * (direto, ou por tipo ATIVO) e, se exigem tamanho, com ao menos um tamanho cadastrado. Material que não exige tamanho nunca é
 * excluído por falta de grade. Sem LIMIT: nenhum teto elimina material elegível. Ordem estável: lower(nome), id.
 *
 * Imagem (Biblioteca de Imagens, Unidade 3 G4): a MESMA imagem vinculada ao material no cadastro (`materiais.imagem_empresa_id` /
 * `imagem_padrao_id`, migration 090), lida por dois LEFT JOIN sobre chaves únicas — a imagem da empresa pela chave composta
 * (empresa_id, id), para nunca cruzar empresas, e a padrão pelo id —, só quando ATIVA; senão as três colunas saem nulas. Os JOINs não
 * filtram nem multiplicam materiais (chave única em cada lado) e o WHERE, a ordem e a seleção da Etapa E não mudam. `imagem_id` é BIGINT:
 * sai como texto do driver e segue como texto decimal no contrato.
 */
async function listarMateriaisAutorizados(executor, { empresaId, gheId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');
  const { rows } = await executor.query(
    `SELECT m.id, m.nome, m.unidade, m.categoria, m.grupo_protecao, m.tipo, m.tipo_material_id, m.exige_tamanho, ${TAMANHOS} AS tamanhos,
            CASE WHEN ie.id IS NOT NULL THEN 'EMPRESA' WHEN ip.id IS NOT NULL THEN 'PADRAO' END AS imagem_origem,
            COALESCE(ie.id, ip.id) AS imagem_id,
            COALESCE(ie.versao, ip.versao) AS imagem_versao
       FROM materiais m
       LEFT JOIN imagens_empresa ie ON ie.empresa_id = m.empresa_id AND ie.id = m.imagem_empresa_id AND ie.estado = 'ATIVA'
       LEFT JOIN imagens_padrao ip ON ip.id = m.imagem_padrao_id AND ip.ativo
      WHERE m.empresa_id = $1 AND m.ativo AND m.exige_tamanho IS NOT NULL AND ${AUTORIZADO}
      ORDER BY lower(m.nome), m.id`,
    [empresaId, gheId],
  );
  return rows;
}

/**
 * A imagem está ATUALMENTE ligada a ao menos um material SELECIONÁVEL do GHE? É a mesma elegibilidade de `listarMateriaisAutorizados` mais o filtro
 * de grade que o serviço do catálogo aplica em JavaScript (`exige_tamanho !== true || tamanhos.length > 0`), aqui em SQL com a MESMA expressão
 * `TAMANHOS`. Os critérios do WHERE (ativo, exige_tamanho classificado, AUTORIZADO) são os de `listarMateriaisAutorizados`; a imagem vale como nos dois
 * LEFT JOIN do catálogo (da empresa: chave composta e ATIVA; padrão: ativa; o CHECK `chk_materiais_uma_imagem` impede os dois vínculos juntos).
 * Uma consulta EXISTS direcionada à imagem (índices idx_materiais_imagem_empresa/_padrao): não monta o catálogo nem consulta por material.
 * `origem` é a do catálogo (`EMPRESA`|`PADRAO`); `imagemId` é o BIGINT em texto decimal canônico. O GHE deve ter sido confirmado ativo por quem chama.
 */
async function imagemAutorizada(executor, { empresaId, gheId, origem, imagemId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');
  if (origem !== 'EMPRESA' && origem !== 'PADRAO') throw new TypeError('origem de imagem inválida');
  if (typeof imagemId !== 'string' || normalizarIdGrande(imagemId) !== imagemId) throw new TypeError('identificador de imagem inválido');
  const vinculo = origem === 'EMPRESA'
    ? `m.imagem_empresa_id = $3::bigint
       AND EXISTS (SELECT 1 FROM imagens_empresa ie WHERE ie.empresa_id = m.empresa_id AND ie.id = m.imagem_empresa_id AND ie.estado = 'ATIVA')`
    : `m.imagem_padrao_id = $3::bigint
       AND EXISTS (SELECT 1 FROM imagens_padrao ip WHERE ip.id = m.imagem_padrao_id AND ip.ativo)`;
  const { rows } = await executor.query(
    `SELECT EXISTS (
        SELECT 1 FROM materiais m
         WHERE m.empresa_id = $1 AND m.ativo AND m.exige_tamanho IS NOT NULL AND ${AUTORIZADO}
           AND (m.exige_tamanho IS NOT TRUE OR cardinality(${TAMANHOS}) > 0)
           AND ${vinculo}) AS autorizada`,
    [empresaId, gheId, imagemId],
  );
  return rows[0].autorizada === true;
}

module.exports = { buscarGheDoFuncionario, listarMateriaisAutorizados, imagemAutorizada };
