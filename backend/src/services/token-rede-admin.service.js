'use strict';

const { HttpError } = require('../errors/HttpError');
const redeRepo = require('../repositories/token-rede-admin.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

/**
 * Atendimento Token — redes autorizadas, administração mínima (Etapa H): listar, cadastrar IP fixo EXATO e desativar. A autorização
 * (ação TOKEN_GERENCIAR_REDES, OBRIGATORIA) mora nas rotas; empresa e ator vêm SEMPRE da sessão. Cada escrita é UMA transação: a rede e a
 * auditoria entram juntas ou nenhuma entra.
 *
 * O que a desativação FAZ e NÃO FAZ: ela só retira o endereço da lista de origens autorizadas. A Etapa C confere a rede em TODA
 * requisição do tablet (credencial + origem), então o tablet atrás daquele IP passa a receber 403 REDE_NAO_AUTORIZADA, mas a credencial
 * NÃO é revogada nem rotacionada: se o endereço voltar a ser autorizado, o mesmo tablet volta a funcionar. Revogar o tablet continua
 * sendo a ação TOKEN_REVOGAR_DISPOSITIVO.
 *
 * Nunca há exclusão física (a auditoria é o histórico). Só IP_FIXO exato; faixa e TUNEL não existem aqui. Rede de outra empresa responde
 * como a inexistente. Auditoria sem segredo: o endereço é configuração da empresa, não credencial.
 */

const ACAO = Object.freeze({ CADASTRADA: 'TOKEN_REDE_CADASTRADA', DESATIVADA: 'TOKEN_REDE_DESATIVADA' });

const naoEncontrada = () => HttpError.notFound('REDE_NAO_ENCONTRADA', 'Rede não encontrada');
const jaAutorizada = () => HttpError.conflict('REDE_JA_AUTORIZADA', 'Este endereço já está autorizado');

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

async function listar(pool, { empresaId, pagina, limite }) {
  exigirId(empresaId, 'identificador de empresa');
  const redes = await redeRepo.listar(pool, empresaId, { pagina, limite });
  const total = await redeRepo.contar(pool, empresaId);
  return { redes, total, pagina, limite };
}

async function cadastrar(pool, { empresaId, atorId, dados, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  return emTransacao(pool, async (client) => {
    let rede;
    try {
      rede = await redeRepo.inserirIpFixo(client, { empresaId, criadoPor: atorId, endereco: dados.rede, descricao: dados.descricao });
    } catch (erro) {
      if (redeRepo.redeJaAtiva(erro)) throw jaAutorizada();
      throw erro;
    }
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO.CADASTRADA, referencia: String(rede.id), ip, dispositivo, dadosNovos: { tipo: rede.tipo, endereco: rede.endereco },
    });
    return rede;
  });
}

async function desativar(pool, { empresaId, atorId, id, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(id, 'identificador de rede');
  return emTransacao(pool, async (client) => {
    const antes = await redeRepo.buscarParaDesativar(client, empresaId, id);
    if (antes === null) throw naoEncontrada();
    // Idempotente: já desativada não muda, não audita de novo.
    if (!antes.ativa) return { rede: antes, alterado: false };
    const rede = await redeRepo.desativar(client, empresaId, id, atorId);
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO.DESATIVADA, referencia: String(id), ip, dispositivo,
      dadosAnteriores: { ativa: true, endereco: antes.endereco }, dadosNovos: { ativa: false },
    });
    return { rede, alterado: true };
  });
}

module.exports = { ACAO, listar, cadastrar, desativar };
