'use strict';

/**
 * Repositório do Suporte (migrations 092 e 093). Executor por parâmetro, SQL parametrizado, nenhuma regra de negócio.
 * Toda leitura do Portal filtra por empresa E usuário da sessão; as leituras da plataforma não têm filtro de empresa
 * (autoridade da plataforma), mas só são chamadas por serviço atrás da sessão administrativa.
 *
 * Conversa (093): `suporte_chamado_respostas` guarda as mensagens dos dois lados (`autor_tipo` SAFEWORK | SOLICITANTE);
 * "não lidas" é derivada dos carimbos do chamado (última mensagem do outro lado depois do meu último visto).
 */

const COLUNAS_CHAMADO = `c.id, c.protocolo, c.assunto, c.categoria, c.descricao, c.situacao, c.criado_em, c.atualizado_em, c.encerrado_em,
  c.ultima_mensagem_solicitante_em, c.ultima_mensagem_suporte_em, c.solicitante_visto_em, c.suporte_visto_em`;
const NAO_LIDAS_SOLICITANTE = `(SELECT count(*) FROM suporte_chamado_respostas r
  WHERE r.chamado_id = c.id AND r.autor_tipo = 'SAFEWORK' AND r.criado_em > COALESCE(c.solicitante_visto_em, '-infinity'))::int AS nao_lidas`;
const NAO_LIDAS_SUPORTE = `(SELECT count(*) FROM suporte_chamado_respostas r
  WHERE r.chamado_id = c.id AND r.autor_tipo = 'SOLICITANTE' AND r.criado_em > COALESCE(c.suporte_visto_em, '-infinity'))::int AS nao_lidas`;

const paraChamado = (l) => ({
  id: Number(l.id),
  protocolo: l.protocolo,
  assunto: l.assunto,
  categoria: l.categoria,
  descricao: l.descricao,
  situacao: l.situacao,
  criadoEm: l.criado_em,
  atualizadoEm: l.atualizado_em,
  encerradoEm: l.encerrado_em,
  ultimaMensagemSolicitanteEm: l.ultima_mensagem_solicitante_em ?? null,
  ultimaMensagemSuporteEm: l.ultima_mensagem_suporte_em ?? null,
  ...(l.nao_lidas === undefined ? {} : { naoLidas: l.nao_lidas }),
});

const paraChamadoPlataforma = (l) => ({
  ...paraChamado(l),
  empresa: { id: l.empresa_id, nome: l.empresa_nome, cnpj: l.empresa_cnpj },
  solicitante: { nome: l.solicitante_nome, email: l.solicitante_email },
});

const paraMensagem = (l) => ({
  id: Number(l.id), autor: l.autor_tipo, texto: l.texto, criadoEm: l.criado_em,
});
const paraSituacao = (l) => ({ id: Number(l.id), de: l.situacao_anterior, para: l.situacao_nova, criadoEm: l.criado_em });

const paraContato = (l) => ({
  id: Number(l.id),
  canal: l.canal,
  assunto: l.assunto,
  situacaoEnvio: l.situacao_envio,
  codigoFalha: l.codigo_falha,
  tentativas: l.tentativas,
  requisicaoHash: l.requisicao_hash,
  criadoEm: l.criado_em,
});

// ---------- Portal: chamados ----------

/** Insere o chamado; se a chave (empresa + usuário + chave) já existe, não insere e devolve null. */
async function inserirChamado(executor, d) {
  const { rows } = await executor.query(
    `INSERT INTO suporte_chamados
       (empresa_id, usuario_id, assunto, categoria, descricao, solicitante_nome, solicitante_email, chave_idempotencia, requisicao_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     ON CONFLICT (empresa_id, usuario_id, chave_idempotencia) DO NOTHING
     RETURNING id, protocolo, assunto, categoria, descricao, situacao, criado_em, atualizado_em, encerrado_em,
               ultima_mensagem_solicitante_em, ultima_mensagem_suporte_em, solicitante_visto_em, suporte_visto_em`,
    [d.empresaId, d.usuarioId, d.assunto, d.categoria, d.descricao, d.solicitanteNome, d.solicitanteEmail, d.chave, d.requisicaoHash],
  );
  return rows.length === 0 ? null : paraChamado(rows[0]);
}

async function buscarChamadoPorChave(executor, { empresaId, usuarioId, chave }) {
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_CHAMADO}, c.requisicao_hash
       FROM suporte_chamados c
      WHERE c.empresa_id = $1 AND c.usuario_id = $2 AND c.chave_idempotencia = $3`,
    [empresaId, usuarioId, chave],
  );
  return rows.length === 0 ? null : { ...paraChamado(rows[0]), requisicaoHash: rows[0].requisicao_hash };
}

async function listarDoUsuario(executor, { empresaId, usuarioId, limite, deslocamento }) {
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_CHAMADO}, ${NAO_LIDAS_SOLICITANTE}
       FROM suporte_chamados c
      WHERE c.empresa_id = $1 AND c.usuario_id = $2
      ORDER BY c.criado_em DESC, c.id DESC
      LIMIT $3 OFFSET $4`,
    [empresaId, usuarioId, limite, deslocamento],
  );
  const total = await executor.query('SELECT count(*)::int AS n FROM suporte_chamados WHERE empresa_id = $1 AND usuario_id = $2', [empresaId, usuarioId]);
  return { itens: rows.map(paraChamado), total: total.rows[0].n };
}

async function buscarDoUsuario(executor, { empresaId, usuarioId, id }, { paraAtualizacao = false } = {}) {
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_CHAMADO}, ${NAO_LIDAS_SOLICITANTE}
       FROM suporte_chamados c
      WHERE c.id = $1 AND c.empresa_id = $2 AND c.usuario_id = $3 ${paraAtualizacao ? 'FOR UPDATE OF c' : ''}`,
    [id, empresaId, usuarioId],
  );
  return rows.length === 0 ? null : paraChamado(rows[0]);
}

// ---------- Conversa (mensagens dos dois lados) ----------

/** Mensagens em ordem estável (id); `aposId` devolve só as mais novas que o id informado. */
async function listarMensagens(executor, chamadoId, { aposId = 0 } = {}) {
  const { rows } = await executor.query(
    `SELECT id, autor_tipo, texto, criado_em FROM suporte_chamado_respostas WHERE chamado_id = $1 AND id > $2 ORDER BY id`,
    [chamadoId, aposId],
  );
  return rows.map(paraMensagem);
}

/** Insere a mensagem; mesma chave no mesmo chamado = não insere e devolve null. */
async function inserirMensagem(executor, {
  chamadoId, autorTipo, administradorId = null, usuarioEmpresaId = null, usuarioId = null, texto, chave = null,
}) {
  const { rows } = await executor.query(
    `INSERT INTO suporte_chamado_respostas (chamado_id, autor_tipo, administrador_id, usuario_empresa_id, usuario_id, texto, chave_idempotencia)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (chamado_id, chave_idempotencia) WHERE chave_idempotencia IS NOT NULL DO NOTHING
     RETURNING id, autor_tipo, texto, criado_em`,
    [chamadoId, autorTipo, administradorId, usuarioEmpresaId, usuarioId, texto, chave],
  );
  return rows.length === 0 ? null : paraMensagem(rows[0]);
}

async function buscarMensagemPorChave(executor, { chamadoId, chave }) {
  const { rows } = await executor.query(
    'SELECT id, autor_tipo, texto, criado_em FROM suporte_chamado_respostas WHERE chamado_id = $1 AND chave_idempotencia = $2',
    [chamadoId, chave],
  );
  return rows.length === 0 ? null : paraMensagem(rows[0]);
}

/** Carimbo da última mensagem do lado informado (e o próprio lado passa a "visto" nesse instante). */
async function registrarMensagemEnviada(executor, { id, lado }) {
  const sql = lado === 'SOLICITANTE'
    ? 'UPDATE suporte_chamados SET ultima_mensagem_solicitante_em = now(), solicitante_visto_em = now() WHERE id = $1'
    : 'UPDATE suporte_chamados SET ultima_mensagem_suporte_em = now(), suporte_visto_em = now() WHERE id = $1';
  await executor.query(sql, [id]);
}

/** O lado informado acabou de ler a conversa. */
async function marcarVisto(executor, { id, lado }) {
  const sql = lado === 'SOLICITANTE'
    ? 'UPDATE suporte_chamados SET solicitante_visto_em = now() WHERE id = $1'
    : 'UPDATE suporte_chamados SET suporte_visto_em = now() WHERE id = $1';
  await executor.query(sql, [id]);
}

async function listarSituacoes(executor, chamadoId) {
  const { rows } = await executor.query(
    'SELECT id, situacao_anterior, situacao_nova, criado_em FROM suporte_chamado_situacoes WHERE chamado_id = $1 ORDER BY id',
    [chamadoId],
  );
  return rows.map(paraSituacao);
}

async function inserirSituacao(executor, { chamadoId, anterior, nova, administradorId }) {
  await executor.query(
    `INSERT INTO suporte_chamado_situacoes (chamado_id, situacao_anterior, situacao_nova, administrador_id) VALUES ($1, $2, $3, $4)`,
    [chamadoId, anterior, nova, administradorId],
  );
}

async function atualizarSituacao(executor, { id, situacao }) {
  const { rows } = await executor.query(
    `UPDATE suporte_chamados
        SET situacao = $2::varchar, encerrado_em = CASE WHEN $2::varchar = 'ENCERRADO' THEN now() ELSE NULL END
      WHERE id = $1
      RETURNING id`,
    [id, situacao],
  );
  return rows.length === 1;
}

// ---------- Portal: contatos ----------

/** Destinatários da PRÓPRIA empresa (a empresa vem sempre da sessão). */
async function buscarEmailsDaEmpresa(executor, empresaId) {
  const { rows } = await executor.query('SELECT email_sst, email_almoxarifado, ativo FROM empresas WHERE id = $1', [empresaId]);
  return rows.length === 0 ? null : { emailSst: rows[0].email_sst, emailAlmoxarifado: rows[0].email_almoxarifado, ativo: rows[0].ativo };
}

async function inserirContato(executor, d) {
  const { rows } = await executor.query(
    `INSERT INTO suporte_contatos (empresa_id, usuario_id, canal, assunto, mensagem, chave_idempotencia, requisicao_hash)
     VALUES ($1, $2, $3, $4, $5, $6, $7)
     ON CONFLICT (empresa_id, usuario_id, chave_idempotencia) DO NOTHING
     RETURNING id, canal, assunto, situacao_envio, codigo_falha, tentativas, requisicao_hash, criado_em`,
    [d.empresaId, d.usuarioId, d.canal, d.assunto, d.mensagem, d.chave, d.requisicaoHash],
  );
  return rows.length === 0 ? null : paraContato(rows[0]);
}

async function buscarContatoPorChave(executor, { empresaId, usuarioId, chave }) {
  const { rows } = await executor.query(
    `SELECT id, canal, assunto, situacao_envio, codigo_falha, tentativas, requisicao_hash, criado_em
       FROM suporte_contatos WHERE empresa_id = $1 AND usuario_id = $2 AND chave_idempotencia = $3`,
    [empresaId, usuarioId, chave],
  );
  return rows.length === 0 ? null : paraContato(rows[0]);
}

/** Só sai de REGISTRADA: o resultado de uma tentativa nunca é reescrito por outra (comparação-e-troca). */
async function registrarResultadoEnvio(executor, { id, situacaoEnvio, codigoFalha }) {
  const { rowCount } = await executor.query(
    `UPDATE suporte_contatos
        SET situacao_envio = $2, codigo_falha = $3, tentativas = tentativas + 1
      WHERE id = $1 AND situacao_envio = 'REGISTRADA'`,
    [id, situacaoEnvio, codigoFalha],
  );
  return rowCount === 1;
}

// ---------- Painel Privado ----------

const BASE_PLATAFORMA = `
  FROM suporte_chamados c
  JOIN empresas e ON e.id = c.empresa_id`;

async function listarPlataforma(executor, {
  situacao, empresaId, busca, naoLidas = false, limite, deslocamento,
}) {
  const filtros = [];
  const valores = [];
  const parametro = (valor) => { valores.push(valor); return `$${valores.length}`; };
  if (situacao) filtros.push(`c.situacao = ${parametro(situacao)}`);
  if (empresaId) filtros.push(`c.empresa_id = ${parametro(empresaId)}`);
  if (busca) {
    const p = parametro(`%${busca.replace(/[\\%_]/g, (m) => `\\${m}`)}%`);
    filtros.push(`(c.protocolo ILIKE ${p} OR c.assunto ILIKE ${p} OR e.nome ILIKE ${p})`);
  }
  if (naoLidas) filtros.push(`c.ultima_mensagem_solicitante_em > COALESCE(c.suporte_visto_em, '-infinity')`);
  const onde = filtros.length === 0 ? '' : `WHERE ${filtros.join(' AND ')}`;
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_CHAMADO}, ${NAO_LIDAS_SUPORTE}, c.empresa_id, e.nome AS empresa_nome, e.cnpj AS empresa_cnpj, c.solicitante_nome, c.solicitante_email
       ${BASE_PLATAFORMA} ${onde}
      ORDER BY c.criado_em DESC, c.id DESC
      LIMIT $${valores.length + 1} OFFSET $${valores.length + 2}`,
    [...valores, limite, deslocamento],
  );
  const total = await executor.query(`SELECT count(*)::int AS n ${BASE_PLATAFORMA} ${onde}`, valores);
  return { itens: rows.map(paraChamadoPlataforma), total: total.rows[0].n };
}

async function buscarPlataforma(executor, id, { paraAtualizacao = false } = {}) {
  const { rows } = await executor.query(
    `SELECT ${COLUNAS_CHAMADO}, ${NAO_LIDAS_SUPORTE}, c.empresa_id, e.nome AS empresa_nome, e.cnpj AS empresa_cnpj, c.solicitante_nome, c.solicitante_email
       ${BASE_PLATAFORMA}
      WHERE c.id = $1 ${paraAtualizacao ? 'FOR UPDATE OF c' : ''}`,
    [id],
  );
  return rows.length === 0 ? null : paraChamadoPlataforma(rows[0]);
}

module.exports = {
  inserirChamado,
  buscarChamadoPorChave,
  listarDoUsuario,
  buscarDoUsuario,
  listarMensagens,
  inserirMensagem,
  buscarMensagemPorChave,
  registrarMensagemEnviada,
  marcarVisto,
  listarSituacoes,
  inserirSituacao,
  atualizarSituacao,
  buscarEmailsDaEmpresa,
  inserirContato,
  buscarContatoPorChave,
  registrarResultadoEnvio,
  listarPlataforma,
  buscarPlataforma,
};
