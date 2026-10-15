'use strict';

const { HttpError } = require('../errors/HttpError');
const dispositivoRepo = require('../repositories/token-dispositivo.repository');
const eventoRepo = require('../repositories/token-dispositivo-evento.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

/**
 * Atendimento Token — administração dos dispositivos (Etapa B). A autorização mora nas rotas (recurso `atendimentoToken` e
 * ação TOKEN_REVOGAR_DISPOSITIVO); aqui ficam o isolamento (empresa e ator SEMPRE da sessão), as regras de domínio, a
 * transação e a trilha.
 *
 * Cada escrita é UMA transação: o dispositivo, o evento (token_dispositivo_eventos) e a auditoria (logs_auditoria) entram
 * juntos ou nenhum entra. O evento diz que algo aconteceu, por quem e quando; os VALORES anteriores e novos ficam na
 * auditoria, só dos campos que mudaram — é assim que o histórico de localização é preservado (a tabela de eventos não tem
 * colunas para valores). A auditoria nunca leva credencial, hash nem código de ativação, e nenhuma chave JSON com a palavra
 * "token" ou "credencial" (o gatilho da migration 014 as recusa).
 *
 * Dispositivo de outra empresa responde como o inexistente (404 DISPOSITIVO_NAO_ENCONTRADO), sem revelar que o id existe.
 * Revogado é somente leitura: editar é 409; revogar de novo é idempotente (nada muda, nada é auditado).
 */

const ACAO = Object.freeze({
  CADASTRADO: 'TOKEN_DISPOSITIVO_CADASTRADO',
  ALTERADO: 'TOKEN_DISPOSITIVO_ALTERADO',
  REVOGADO: 'TOKEN_DISPOSITIVO_REVOGADO',
});
const CAMPOS = Object.freeze(Object.keys(dispositivoRepo.COLUNAS_EDITAVEIS));

const naoEncontrado = () => HttpError.notFound('DISPOSITIVO_NAO_ENCONTRADO', 'Dispositivo não encontrado');
const revogado = () => HttpError.conflict('DISPOSITIVO_REVOGADO', 'Dispositivo revogado não pode ser alterado');

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

/** Violação de unicidade do banco -> 409 do domínio; qualquer outro erro segue como veio. */
function traduzirUnicidade(erro) {
  const qual = dispositivoRepo.unicidadeViolada(erro);
  if (qual === 'NOME') return HttpError.conflict('DISPOSITIVO_NOME_EM_USO', 'Já existe um dispositivo com este nome nesta empresa');
  if (qual === 'NUMERO_SERIE') return HttpError.conflict('DISPOSITIVO_NUMERO_SERIE_EM_USO', 'Já existe um dispositivo com este número de série nesta empresa');
  return erro;
}

/** Os sete campos administrativos como a API os conhece (a partir do dispositivo público). */
const camposDe = (dispositivo) => Object.fromEntries(CAMPOS.map((c) => [c, dispositivo[c]]));

async function cadastrar(pool, { empresaId, atorId, dados, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  return emTransacao(pool, async (client) => {
    let linha;
    try {
      linha = await dispositivoRepo.inserir(client, { empresaId, criadoPor: atorId, ...dados });
    } catch (erro) {
      throw traduzirUnicidade(erro);
    }
    const criado = dispositivoRepo.mapear(linha);
    await eventoRepo.registrar(client, { empresaId, dispositivoId: criado.id, tipo: 'CADASTRO', usuarioId: atorId });
    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO.CADASTRADO,
      referencia: String(criado.id),
      ip,
      dispositivo,
      contexto: { identificador: criado.identificador },
      dadosNovos: camposDe(criado),
    });
    return criado;
  });
}

async function listar(pool, { empresaId, pagina, limite }) {
  exigirId(empresaId, 'identificador de empresa');
  const [linhas, total] = await Promise.all([dispositivoRepo.listar(pool, empresaId, { pagina, limite }), dispositivoRepo.contar(pool, empresaId)]);
  return { dispositivos: linhas.map(dispositivoRepo.mapear), total, pagina, limite };
}

async function consultar(pool, { empresaId, id }) {
  exigirId(empresaId, 'identificador de empresa');
  const linha = await dispositivoRepo.buscarPorId(pool, empresaId, id);
  if (linha === null) throw naoEncontrado();
  return dispositivoRepo.mapear(linha);
}

async function editar(pool, { empresaId, atorId, id, dados, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  return emTransacao(pool, async (client) => {
    const atual = await dispositivoRepo.buscarParaAtualizacao(client, empresaId, id);
    if (atual === null) throw naoEncontrado();
    const antes = dispositivoRepo.mapear(atual);
    if (antes.situacao === 'REVOGADO') throw revogado();

    // Só o que realmente muda: o resto não vai ao UPDATE, ao evento nem à auditoria.
    const mudancas = {};
    const anteriores = {};
    for (const campo of CAMPOS) {
      if (dados[campo] !== undefined && dados[campo] !== antes[campo]) {
        mudancas[campo] = dados[campo];
        anteriores[campo] = antes[campo];
      }
    }
    if (Object.keys(mudancas).length === 0) return { dispositivo: antes, alterado: false };

    let linha;
    try {
      linha = await dispositivoRepo.atualizar(client, empresaId, id, mudancas);
    } catch (erro) {
      throw traduzirUnicidade(erro);
    }
    await eventoRepo.registrar(client, { empresaId, dispositivoId: id, tipo: 'ALTERACAO', usuarioId: atorId });
    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO.ALTERADO,
      referencia: String(id),
      ip,
      dispositivo,
      dadosAnteriores: anteriores,
      dadosNovos: mudancas,
    });
    return { dispositivo: dispositivoRepo.mapear(linha), alterado: true };
  });
}

async function revogar(pool, { empresaId, atorId, id, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  return emTransacao(pool, async (client) => {
    const atual = await dispositivoRepo.buscarParaAtualizacao(client, empresaId, id);
    if (atual === null) throw naoEncontrado();
    const antes = dispositivoRepo.mapear(atual);
    // Idempotente: o primeiro responsável e o instante ficam; nenhum evento nem auditoria novos.
    if (antes.situacao === 'REVOGADO') return { dispositivo: antes, alterado: false };

    const linha = await dispositivoRepo.revogar(client, empresaId, id, atorId);
    const ativacoesCanceladas = await dispositivoRepo.cancelarAtivacoesPendentes(client, empresaId, id);
    const atendimentosEncerrados = await dispositivoRepo.encerrarAtendimentosAbertos(client, empresaId, id);
    await eventoRepo.registrar(client, { empresaId, dispositivoId: id, tipo: 'REVOGACAO', usuarioId: atorId });
    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO.REVOGADO,
      referencia: String(id),
      ip,
      dispositivo,
      contexto: { ativacoesCanceladas, atendimentosEncerrados },
      dadosAnteriores: { situacao: antes.situacao },
      dadosNovos: { situacao: 'REVOGADO' },
    });
    return { dispositivo: dispositivoRepo.mapear(linha), alterado: true };
  });
}

module.exports = { ACAO, cadastrar, listar, consultar, editar, revogar };
