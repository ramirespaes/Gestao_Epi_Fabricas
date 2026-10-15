'use strict';

const { HttpError } = require('../errors/HttpError');
const { gerarTokenSessao, hashTokenSessao } = require('../security/token');
const credencialRepo = require('../repositories/token-credencial.repository');
const ativacaoRepo = require('../repositories/token-ativacao.repository');
const eventoRepo = require('../repositories/token-dispositivo-evento.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

/**
 * Atendimento Token — geração administrativa do código de ativação (Etapa C). A autoridade (ação TOKEN_GERAR_ATIVACAO) mora
 * na rota; empresa e ator vêm SEMPRE da sessão. O código tem 256 bits (a mesma fonte criptográfica das sessões), vive 10
 * minutos e só o SHA-256 chega ao banco; o código em claro volta UMA vez ao usuário autorizado (para o QR Code futuro) e
 * não entra em auditoria, evento nem log.
 *
 * Uma ativação pendente por tablet: gerar de novo CANCELA a anterior (inclusive a expirada que ainda ocupa o índice único
 * parcial da 086), sob a trava da linha do tablet, que é sempre a primeira trava de qualquer operação de ativação.
 *
 * Tablet ATIVO também pode receber código (recuperação, D-C2). Gerar NÃO mexe na credencial em uso: ela segue valendo até o
 * consumo válido do código, que a substitui atomicamente (token-tablet.service). Tablet revogado é 409.
 */

const ACAO_GERADA = 'TOKEN_ATIVACAO_GERADA';

const naoEncontrado = () => HttpError.notFound('DISPOSITIVO_NAO_ENCONTRADO', 'Dispositivo não encontrado');
const revogado = () => HttpError.conflict('DISPOSITIVO_REVOGADO', 'Dispositivo revogado não pode ser ativado');

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erro) {
      await client.query('ROLLBACK');
      throw erro;
    }
  } finally {
    client.release();
  }
}

async function gerar(pool, { empresaId, atorId, dispositivoId, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(dispositivoId, 'identificador de dispositivo');
  return emTransacao(pool, async (client) => {
    const tablet = await credencialRepo.travarDispositivo(client, empresaId, dispositivoId);
    if (tablet === null) throw naoEncontrado();
    if (tablet.revogado_em !== null) throw revogado();

    await ativacaoRepo.cancelarPendentes(client, empresaId, dispositivoId);
    const codigo = gerarTokenSessao();
    const { expira_em: expiraEm } = await ativacaoRepo.inserir(client, { empresaId, dispositivoId, codigoHash: hashTokenSessao(codigo), criadoPor: atorId });
    await eventoRepo.registrar(client, { empresaId, dispositivoId, tipo: 'ATIVACAO_GERADA', usuarioId: atorId });
    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_GERADA,
      referencia: String(dispositivoId),
      ip,
      dispositivo,
      // Só se o tablet já estava ativo (recuperação). Nenhuma chave com "token", "credencial" ou "hash".
      contexto: { reativacao: tablet.credencial_hash !== null },
    });
    return { dispositivoId, codigo, expiraEm: expiraEm.toISOString() };
  });
}

module.exports = { ACAO_GERADA, gerar };
