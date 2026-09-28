'use strict';

const validacao = require('./validacao-mfa');

/**
 * Desafios pré-MFA (migration 052). Só primitivas: o limite de desafios
 * abertos, a trava do administrador e as transições são do serviço. Só o
 * hash do token chega aqui e nunca volta para quem chama.
 *
 * Validade (aberto, dentro do prazo, administrador ativo) fica toda na
 * consulta; encerrar é sempre condicional a estar aberto. Instantes vêm do
 * relógio do banco.
 */

const TIPOS = new Set(['LIBERACAO', 'CADASTRO', 'VERIFICACAO', 'RECUPERACAO', 'SUBSTITUICAO']);
const TIPOS_COM_FATOR = new Set(['CADASTRO', 'RECUPERACAO', 'SUBSTITUICAO']);
const MANTER_ABERTOS_MAXIMO = 100;

const COLUNAS = `d.id, d.administrador_id, d.tipo, d.fator_pendente_id, d.sessao_origem_id, d.sessao_criada_id,
       d.desafio_anterior_id, d.criado_em, d.expira_em, d.falhas, d.reinicios, d.encerrado_em,
       d.motivo_encerramento, (d.encerrado_em IS NULL AND d.expira_em > clock_timestamp()) AS vigente`;

function paraDesafio(linha) {
  return {
    id: linha.id,
    administradorId: linha.administrador_id,
    tipo: linha.tipo,
    fatorPendenteId: linha.fator_pendente_id,
    sessaoOrigemId: linha.sessao_origem_id,
    sessaoCriadaId: linha.sessao_criada_id,
    desafioAnteriorId: linha.desafio_anterior_id,
    criadoEm: linha.criado_em,
    expiraEm: linha.expira_em,
    falhas: linha.falhas,
    reinicios: linha.reinicios,
    encerradoEm: linha.encerrado_em,
    motivoEncerramento: linha.motivo_encerramento,
    vigente: linha.vigente,
  };
}

function exigirTokenHash(tokenHash) {
  validacao.exigirHash(tokenHash, 'token do desafio');
}

/** Mesmas regras de vínculo por tipo que os CHECKs da 052, antes de ir ao banco. */
async function criar(executor, {
  administradorId,
  tokenHash,
  tipo,
  validadeMinutos,
  fatorPendenteId = null,
  sessaoOrigemId = null,
  desafioAnteriorId = null,
}) {
  validacao.exigirAdministrador(administradorId);
  exigirTokenHash(tokenHash);
  if (!TIPOS.has(tipo)) {
    throw new TypeError('tipo de desafio desconhecido');
  }
  validacao.exigirIdOpcional(fatorPendenteId, 'fator');
  validacao.exigirIdOpcional(sessaoOrigemId, 'sessão');
  validacao.exigirIdOpcional(desafioAnteriorId, 'desafio anterior');
  if (TIPOS_COM_FATOR.has(tipo) !== (fatorPendenteId !== null)) {
    throw new TypeError('fator pendente incoerente com o tipo do desafio');
  }
  if ((tipo === 'SUBSTITUICAO') !== (sessaoOrigemId !== null)) {
    throw new TypeError('sessão de origem incoerente com o tipo do desafio');
  }
  validacao.exigirMinutos(validadeMinutos);

  const { rows } = await executor.query(
    `WITH agora AS (SELECT clock_timestamp() AS t)
     INSERT INTO desafios_mfa_plataforma
       (administrador_id, token_hash, tipo, fator_pendente_id, sessao_origem_id, desafio_anterior_id, criado_em, expira_em)
     VALUES ($1, $2, $3, $4, $5, $6, (SELECT t FROM agora), (SELECT t FROM agora) + ($7 * INTERVAL '1 minute'))
     RETURNING id, criado_em, expira_em`,
    [administradorId, tokenHash, tipo, fatorPendenteId, sessaoOrigemId, desafioAnteriorId, validadeMinutos],
  );
  return { id: rows[0].id, criadoEm: rows[0].criado_em, expiraEm: rows[0].expira_em };
}

/** Em qualquer situação (encerrado, vencido): para logout e para o estado. */
async function buscarPorHash(executor, tokenHash) {
  exigirTokenHash(tokenHash);

  const { rows } = await executor.query(
    `SELECT ${COLUNAS}
       FROM desafios_mfa_plataforma d
      WHERE d.token_hash = $1`,
    [tokenHash],
  );
  return rows[0] === undefined ? null : paraDesafio(rows[0]);
}

/** Aberto, no prazo e de administrador ativo; com travar, trava só o desafio. */
async function buscarValidoPorHash(executor, tokenHash, opcoes) {
  exigirTokenHash(tokenHash);
  const travar = validacao.travarPedido(opcoes);

  const { rows } = await executor.query(
    `SELECT ${COLUNAS}
       FROM desafios_mfa_plataforma d
       JOIN administradores_plataforma a ON a.id = d.administrador_id
      WHERE d.token_hash = $1
        AND d.encerrado_em IS NULL
        AND d.expira_em > clock_timestamp()
        AND a.ativo${travar ? '\n      FOR UPDATE OF d' : ''}`,
    [tokenHash],
  );
  return rows[0] === undefined ? null : paraDesafio(rows[0]);
}

/**
 * Mesma validade de buscarValidoPorHash, pelo id que o middleware já
 * resolveu: as etapas do cadastro releem o desafio dentro da transação,
 * com trava, depois da trava do administrador.
 */
async function buscarValidoPorId(executor, { desafioId, administradorId }, opcoes) {
  validacao.exigirId(desafioId, 'desafio');
  validacao.exigirAdministrador(administradorId);
  const travar = validacao.travarPedido(opcoes);

  const { rows } = await executor.query(
    `SELECT ${COLUNAS}
       FROM desafios_mfa_plataforma d
       JOIN administradores_plataforma a ON a.id = d.administrador_id
      WHERE d.id = $1
        AND d.administrador_id = $2
        AND d.encerrado_em IS NULL
        AND d.expira_em > clock_timestamp()
        AND a.ativo${travar ? '\n      FOR UPDATE OF d' : ''}`,
    [desafioId, administradorId],
  );
  return rows[0] === undefined ? null : paraDesafio(rows[0]);
}

/**
 * Reinício do cadastro: aponta o desafio aberto para o fator pendente novo e
 * conta o reinício, só enquanto houver reinício disponível. false = limite
 * atingido ou desafio já encerrado.
 */
async function trocarFatorPendente(executor, { desafioId, fatorPendenteId, maximoReinicios }) {
  validacao.exigirId(desafioId, 'desafio');
  validacao.exigirId(fatorPendenteId, 'fator');
  if (!Number.isInteger(maximoReinicios) || maximoReinicios < 1 || maximoReinicios > 100) {
    throw new TypeError('limite de reinícios inválido');
  }

  const { rowCount } = await executor.query(
    `UPDATE desafios_mfa_plataforma
        SET fator_pendente_id = $2, reinicios = reinicios + 1
      WHERE id = $1 AND encerrado_em IS NULL AND fator_pendente_id IS NOT NULL AND reinicios < $3`,
    [desafioId, fatorPendenteId, maximoReinicios],
  );
  return rowCount > 0;
}

/** Abertos (vencidos ou não), do mais antigo para o mais novo. */
async function listarAbertos(executor, administradorId, opcoes) {
  validacao.exigirAdministrador(administradorId);
  const travar = validacao.travarPedido(opcoes);

  const { rows } = await executor.query(
    `SELECT ${COLUNAS}
       FROM desafios_mfa_plataforma d
      WHERE d.administrador_id = $1 AND d.encerrado_em IS NULL
      ORDER BY d.criado_em, d.id${travar ? '\n      FOR UPDATE' : ''}`,
    [administradorId],
  );
  return rows.map(paraDesafio);
}

/** Novo total de falhas, ou null se o desafio já estava encerrado. */
async function incrementarFalhas(executor, desafioId) {
  validacao.exigirId(desafioId, 'desafio');

  const { rows } = await executor.query(
    `UPDATE desafios_mfa_plataforma
        SET falhas = falhas + 1
      WHERE id = $1 AND encerrado_em IS NULL
      RETURNING falhas`,
    [desafioId],
  );
  return rows[0] === undefined ? null : rows[0].falhas;
}

async function encerrar(executor, { desafioId, motivo }) {
  validacao.exigirId(desafioId, 'desafio');
  validacao.exigirMotivo(motivo);

  const { rowCount } = await executor.query(
    `UPDATE desafios_mfa_plataforma
        SET encerrado_em = clock_timestamp(), motivo_encerramento = $2
      WHERE id = $1 AND encerrado_em IS NULL`,
    [desafioId, motivo],
  );
  return rowCount > 0;
}

async function encerrarExpirados(executor, administradorId) {
  validacao.exigirAdministrador(administradorId);

  const { rowCount } = await executor.query(
    `UPDATE desafios_mfa_plataforma
        SET encerrado_em = clock_timestamp(), motivo_encerramento = 'EXPIRADO'
      WHERE administrador_id = $1 AND encerrado_em IS NULL AND expira_em <= clock_timestamp()`,
    [administradorId],
  );
  return rowCount;
}

/**
 * Deixa abertos só os `manterAbertos` mais novos e encerra o resto. Sem a
 * trava do administrador, duas chamadas concorrentes poderiam somar mais
 * abertos que o previsto: quem chama segura a trava.
 */
async function encerrarMaisAntigos(executor, { administradorId, manterAbertos, motivo }) {
  validacao.exigirAdministrador(administradorId);
  if (!Number.isInteger(manterAbertos) || manterAbertos < 0 || manterAbertos > MANTER_ABERTOS_MAXIMO) {
    throw new TypeError('quantidade de desafios a manter inválida');
  }
  validacao.exigirMotivo(motivo);

  const { rowCount } = await executor.query(
    `UPDATE desafios_mfa_plataforma
        SET encerrado_em = clock_timestamp(), motivo_encerramento = $3
      WHERE encerrado_em IS NULL
        AND id IN (SELECT id
                     FROM desafios_mfa_plataforma
                    WHERE administrador_id = $1 AND encerrado_em IS NULL
                    ORDER BY criado_em DESC, id DESC
                   OFFSET $2)`,
    [administradorId, manterAbertos, motivo],
  );
  return rowCount;
}

async function encerrarAbertos(executor, { administradorId, motivo, exceto = null }) {
  validacao.exigirAdministrador(administradorId);
  validacao.exigirMotivo(motivo);
  validacao.exigirIdOpcional(exceto, 'desafio');

  const { rowCount } = await executor.query(
    `UPDATE desafios_mfa_plataforma
        SET encerrado_em = clock_timestamp(), motivo_encerramento = $2
      WHERE administrador_id = $1 AND encerrado_em IS NULL
        AND ($3::bigint IS NULL OR id <> $3::bigint)`,
    [administradorId, motivo, exceto],
  );
  return rowCount;
}

/** Só num desafio CONCLUIDO e uma vez; a FK composta exige sessão do mesmo administrador. */
async function ligarSessaoCriada(executor, { desafioId, sessaoId }) {
  validacao.exigirId(desafioId, 'desafio');
  validacao.exigirId(sessaoId, 'sessão');

  const { rowCount } = await executor.query(
    `UPDATE desafios_mfa_plataforma
        SET sessao_criada_id = $2
      WHERE id = $1 AND sessao_criada_id IS NULL AND motivo_encerramento = 'CONCLUIDO'`,
    [desafioId, sessaoId],
  );
  return rowCount > 0;
}

module.exports = {
  criar,
  buscarPorHash,
  buscarValidoPorHash,
  buscarValidoPorId,
  listarAbertos,
  incrementarFalhas,
  encerrar,
  encerrarExpirados,
  encerrarMaisAntigos,
  encerrarAbertos,
  ligarSessaoCriada,
  trocarFatorPendente,
};
