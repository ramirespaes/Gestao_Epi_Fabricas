'use strict';

/**
 * Fontes de dados dos módulos do pacote de fiscalização (12K-D6). Cada módulo tem uma ou mais SAÍDAS (arquivos); cada saída
 * declara as colunas exportadas (lista explícita: nunca SELECT *) e o SQL. A contagem e a leitura saem do MESMO FROM/WHERE,
 * para que o número da prévia seja o das linhas exportadas. Tudo é parametrizado e filtrado pela empresa da sessão; a leitura é
 * por keyset (sem OFFSET). Só leitura: nada aqui decide RBAC, gera ZIP ou grava pacote.
 *
 * Fica de fora, de propósito: CPF, hash de senha, token, traços brutos da assinatura, texto livre de justificativas, contexto,
 * dados anteriores/novos e descrição da auditoria.
 *
 * HISTÓRICO x POSIÇÃO: o que o banco preserva historicamente (movimentos append-only, snapshots da entrega, trilha) sai como
 * histórico. O que reflete o estado atual (saldo do lote, vínculo GHE -> material, e os atributos de lote e material, que o banco
 * não versiona) sai rotulado como "posição na data da geração", numa saída distinta, e nunca como parte de um evento passado.
 */

const FUSO = 'America/Sao_Paulo';
// Dia civil do período em São Paulo, como intervalo de instantes (usa o índice por empresa e data).
const NO_PERIODO = (coluna) => `${coluna} >= ($2::date)::timestamp AT TIME ZONE '${FUSO}'
    AND ${coluna} < (($3::date + 1)::timestamp AT TIME ZONE '${FUSO}')`;
const LOCAL = (coluna) => `to_char(${coluna} AT TIME ZONE '${FUSO}', 'YYYY-MM-DD"T"HH24:MI:SS')`;

const SAIDAS_POR_ESCOPO = Object.freeze({
  FICHAS_ENTREGAS_CONFIRMADAS: Object.freeze([Object.freeze({
    id: 'ENTREGAS_CONFIRMADAS',
    arquivo: 'fichas-entregas-confirmadas',
    temporal: true,
    colunas: Object.freeze([
      'ficha_numero', 'entrega_id', 'data_operacional', 'entregue_em', 'origem', 'trabalhador_nome', 'trabalhador_matricula',
      'trabalhador_funcao', 'trabalhador_setor', 'ghe_nome', 'responsavel_nome', 'material_nome', 'material_tipo', 'tamanho',
      'ca_numero', 'ca_validade', 'quantidade', 'motivo', 'previsto_no_ghe', 'modo_confirmacao', 'confirmada_em', 'declaracao_versao',
      'declaracao_texto', 'hash_conteudo',
    ]),
    cursor: Object.freeze([{ sql: 'i.id', tipo: 'integer' }]),
    // Snapshots congelados da entrega (trabalhador, GHE, responsável, material); tamanho e CA vêm do lote entregue.
    // hash_conteudo é hash de integridade do conteúdo registrado (não é assinatura digital nem criptográfica); os traços ficam fora.
    selecionar: `f.numero AS ficha_numero, e.id AS entrega_id, to_char(e.data_operacional, 'YYYY-MM-DD') AS data_operacional,
      ${LOCAL('e.entregue_em')} AS entregue_em, e.origem, e.trabalhador_nome, e.trabalhador_matricula, e.trabalhador_funcao,
      e.trabalhador_setor, e.ghe_nome, e.responsavel_nome, i.material_nome, i.material_tipo, l.tamanho, l.ca_numero,
      to_char(l.ca_validade, 'YYYY-MM-DD') AS ca_validade, i.quantidade, i.motivo, i.previsto_no_ghe, c.modo AS modo_confirmacao,
      ${LOCAL('c.confirmada_em')} AS confirmada_em, c.declaracao_versao, c.declaracao_texto, c.hash_conteudo`,
    de: `entregas_epi e
      JOIN entregas_epi_confirmacoes c ON c.empresa_id = e.empresa_id AND c.entrega_id = e.id
      JOIN fichas_epi f ON f.empresa_id = e.empresa_id AND f.id = e.ficha_id
      JOIN entregas_epi_itens i ON i.empresa_id = e.empresa_id AND i.entrega_id = e.id
      JOIN estoque_lotes l ON l.empresa_id = i.empresa_id AND l.id = i.lote_id`,
    onde: 'e.empresa_id = $1 AND e.data_operacional BETWEEN $2::date AND $3::date',
  })]),
  TRILHA_AUDITORIA: Object.freeze([Object.freeze({
    id: 'TRILHA',
    arquivo: 'trilha-auditoria',
    temporal: true,
    // referencia_amigavel é resolvida pelo serviço (mesma regra da aba Auditoria); aqui só os campos da própria tabela.
    colunas: Object.freeze(['data_hora', 'usuario', 'perfil', 'acao', 'referencia', 'ip', 'dispositivo']),
    cursor: Object.freeze([{ sql: 'l.id', tipo: 'bigint' }]),
    selecionar: `${LOCAL('l.criado_em')} AS data_hora, COALESCE(u.nome, 'Sistema automático') AS usuario, l.perfil_ator AS perfil,
      l.acao, l.referencia, l.ip, l.dispositivo`,
    de: `logs_auditoria l
      LEFT JOIN usuarios u ON u.empresa_id = l.empresa_id AND u.id = l.usuario_id`,
    onde: `l.empresa_id = $1 AND ${NO_PERIODO('l.criado_em')}`,
  })]),
  HISTORICO_ESTOQUE_CA: Object.freeze([
    Object.freeze({
      id: 'MOVIMENTOS',
      arquivo: 'historico-estoque-ca',
      temporal: true,
      // Movimentos reais (append-only), pela empresa e pelo período. Tamanho, CA e nome do material são os atributos ATUAIS do lote e
      // do cadastro (o banco não os versiona); o saldo do lote NÃO entra aqui: ele é posição na geração, em saída própria.
      colunas: Object.freeze(['data_hora', 'tipo', 'quantidade', 'motivo', 'material_nome', 'tamanho', 'ca_numero', 'ca_validade', 'lote_id', 'usuario']),
      cursor: Object.freeze([{ sql: 'o.id', tipo: 'bigint' }]),
      selecionar: `${LOCAL('o.criado_em')} AS data_hora, o.tipo, o.quantidade, o.motivo, m.nome AS material_nome, l.tamanho, l.ca_numero,
        to_char(l.ca_validade, 'YYYY-MM-DD') AS ca_validade, l.id AS lote_id, u.nome AS usuario`,
      de: `estoque_operacoes o
        JOIN estoque_lotes l ON l.empresa_id = o.empresa_id AND l.id = o.lote_id
        JOIN materiais m ON m.empresa_id = l.empresa_id AND m.id = l.material_id
        LEFT JOIN usuarios u ON u.empresa_id = o.empresa_id AND u.id = o.usuario_id`,
      onde: `o.empresa_id = $1 AND ${NO_PERIODO('o.criado_em')}`,
    }),
    Object.freeze({
      id: 'POSICAO_LOTES',
      arquivo: 'posicao-lotes-na-geracao',
      temporal: false,
      // Posição na data da geração: os lotes com saldo hoje, tenham ou não tido movimento no período.
      colunas: Object.freeze(['lote_id', 'material_nome', 'material_tipo', 'tamanho', 'ca_numero', 'ca_validade', 'entrada_em', 'quantidade_entrada', 'saldo_posicao_na_geracao']),
      cursor: Object.freeze([{ sql: 'l.id', tipo: 'integer' }]),
      selecionar: `l.id AS lote_id, m.nome AS material_nome, m.tipo AS material_tipo, l.tamanho, l.ca_numero,
        to_char(l.ca_validade, 'YYYY-MM-DD') AS ca_validade, ${LOCAL('l.criado_em')} AS entrada_em, l.quantidade_entrada,
        l.saldo AS saldo_posicao_na_geracao`,
      de: `estoque_lotes l
        JOIN materiais m ON m.empresa_id = l.empresa_id AND m.id = l.material_id`,
      onde: 'l.empresa_id = $1 AND l.saldo > 0',
    }),
  ]),
  REGRAS_GHE: Object.freeze([Object.freeze({
    id: 'GHE_MATERIAL',
    arquivo: 'regras-ghe',
    temporal: false,
    // Posição atual GHE -> material (vínculo explícito existente). Sem setor/função do GHE, sem elegibilidade e sem inferência.
    colunas: Object.freeze(['ghe_id', 'ghe_nome', 'ghe_ativo', 'material_id', 'material_nome', 'material_tipo', 'material_ativo']),
    cursor: Object.freeze([{ sql: 'g.id', tipo: 'integer' }, { sql: 'COALESCE(gm.material_id, 0)', tipo: 'integer' }]),
    selecionar: `g.id AS ghe_id, g.nome AS ghe_nome, g.ativo AS ghe_ativo, gm.material_id, m.nome AS material_nome,
      m.tipo AS material_tipo, m.ativo AS material_ativo`,
    de: `grupos_homogeneos_exposicao g
      LEFT JOIN ghe_materiais gm ON gm.empresa_id = g.empresa_id AND gm.grupo_homogeneo_id = g.id
      LEFT JOIN materiais m ON m.empresa_id = gm.empresa_id AND m.id = gm.material_id`,
    onde: 'g.empresa_id = $1',
  })]),
});

const ESCOPOS = Object.freeze(Object.keys(SAIDAS_POR_ESCOPO));

function saidasDe(escopo) {
  if (!Object.hasOwn(SAIDAS_POR_ESCOPO, escopo)) throw new TypeError('módulo de fiscalização desconhecido');
  return SAIDAS_POR_ESCOPO[escopo];
}
function saida(escopo, id) {
  const s = saidasDe(escopo).find((x) => x.id === id);
  if (!s) throw new TypeError('saída de fiscalização desconhecida');
  return s;
}
const parametrosBase = (s, { empresaId, inicio, fim }) => (s.temporal ? [empresaId, inicio, fim] : [empresaId]);

/** Linhas efetivamente exportáveis de cada saída do módulo, e o total (é o total que o limite por módulo considera). */
async function contarEscopo(executor, escopo, contexto) {
  const saidas = [];
  for (const s of saidasDe(escopo)) {
    const { rows } = await executor.query(`SELECT count(*)::int AS n FROM ${s.de} WHERE ${s.onde}`, parametrosBase(s, contexto));
    saidas.push({ id: s.id, arquivo: s.arquivo, linhas: rows[0].n });
  }
  return { total: saidas.reduce((soma, s) => soma + s.linhas, 0), saidas };
}

/** Próximo lote de até `limite` linhas depois do cursor (null na primeira leitura). Devolve { linhas, cursor } (cursor null no fim). */
async function lerLote(executor, escopo, saidaId, contexto, cursor, limite) {
  const s = saida(escopo, saidaId);
  const params = parametrosBase(s, contexto);
  const expressoes = s.cursor.map((c) => c.sql);
  let depois = '';
  if (cursor && cursor.length === s.cursor.length) {
    const marcadores = s.cursor.map((c, i) => `$${params.length + i + 1}::${c.tipo}`);
    depois = ` AND (${expressoes.join(', ')}) > (${marcadores.join(', ')})`;
    params.push(...cursor);
  }
  params.push(limite);
  const cursores = expressoes.map((sql, i) => `${sql} AS _c${i + 1}`).join(', ');
  const { rows } = await executor.query(
    `SELECT ${s.selecionar}, ${cursores} FROM ${s.de} WHERE ${s.onde}${depois} ORDER BY ${expressoes.join(', ')} LIMIT $${params.length}`,
    params,
  );
  const ultima = rows[rows.length - 1];
  const proximo = ultima ? s.cursor.map((_c, i) => String(ultima[`_c${i + 1}`])) : null;
  const linhas = rows.map((r) => {
    const saidaLinha = {};
    for (const c of s.colunas) if (c in r) saidaLinha[c] = r[c];
    return saidaLinha;
  });
  return { linhas, cursor: rows.length === limite ? proximo : null };
}

module.exports = { ESCOPOS, SAIDAS_POR_ESCOPO, saidasDe, contarEscopo, lerLote };
