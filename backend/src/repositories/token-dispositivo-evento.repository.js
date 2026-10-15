'use strict';

/**
 * Histórico do dispositivo (token_dispositivo_eventos, migration 086): append-only (o banco recusa UPDATE, DELETE e TRUNCATE).
 * Guarda QUE aconteceu, QUEM e QUANDO; os VALORES das alterações ficam na auditoria (logs_auditoria.dados_anteriores/dados_novos),
 * porque esta tabela não tem colunas para eles. O heartbeat não grava um evento por batida.
 */

const TIPOS = Object.freeze([
  'CADASTRO', 'ALTERACAO', 'ATIVACAO_GERADA', 'ATIVACAO', 'REVOGACAO', 'CREDENCIAL_RENOVADA', 'REUSO_CREDENCIAL', 'REDE_RECUSADA', 'QUEDA', 'RESTABELECIMENTO',
]);

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

async function registrar(executor, { empresaId, dispositivoId, tipo, usuarioId = null, duracaoSegundos = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(dispositivoId, 'identificador de dispositivo');
  if (!TIPOS.includes(tipo)) throw new TypeError('tipo de evento inválido');
  if (usuarioId !== null) exigirId(usuarioId, 'identificador de usuário');
  const { rows } = await executor.query(
    `INSERT INTO token_dispositivo_eventos (empresa_id, dispositivo_id, tipo, usuario_id, duracao_segundos)
     VALUES ($1, $2, $3, $4, $5) RETURNING id`,
    [empresaId, dispositivoId, tipo, usuarioId, duracaoSegundos],
  );
  return rows[0].id;
}

module.exports = { TIPOS, registrar };
