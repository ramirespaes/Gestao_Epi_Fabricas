'use strict';

const { HttpError } = require('../errors/HttpError');
const usuarioRepo = require('../repositories/usuario.repository');
const vinculoRepo = require('../repositories/vinculo-sst.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { PERFIL_MASTER } = require('./autoridade-administrativa');

/**
 * Administração do vínculo SST (12B; rotas HTTP na 12F, vinculo-sst.routes.js).
 * Só o MASTER ativo da própria empresa concede, remove e lista, sem ação
 * administrativa nova e sem tocar a autorização existente: a decisão de quem
 * integra a SST continua lida de vinculo_sst pela camada de autorização
 * (permissao.repository.usuarioIntegraSst).
 *
 * empresaId e atorId vêm da sessão. Quem não tem autoridade recebe sempre o
 * mesmo 403, sem revelar se o ator existe, está inativo ou é de outra empresa;
 * o usuário alvo de outra empresa é "não encontrado". Ator e alvo são
 * travados (FOR UPDATE) em ordem crescente de id, para duas concessões
 * cruzadas não formarem ciclo, e a auditoria entra na mesma transação, só com
 * ids e indicadores, sem texto livre.
 */

const ACAO_ADICIONADO = 'VINCULO_SST_ADICIONADO';
const ACAO_REMOVIDO = 'VINCULO_SST_REMOVIDO';
const MOTIVO_MAXIMO = vinculoRepo.MOTIVO_MAXIMO;
const CARACTERE_CONTROLE = /\p{Cc}/u;

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

async function emTransacao(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erroTransacional) {
      await client.query('ROLLBACK');
      throw erroTransacional;
    }
  } finally {
    client.release();
  }
}

async function emLeitura(pool, operacao) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    try {
      const resultado = await operacao(client);
      await client.query('COMMIT');
      return resultado;
    } catch (erroLeitura) {
      await client.query('ROLLBACK');
      throw erroLeitura;
    }
  } finally {
    client.release();
  }
}

function motivoOpcional(motivo) {
  if (motivo === null || motivo === undefined) return null;
  const texto = typeof motivo === 'string' ? motivo.trim().normalize('NFC') : null;
  const tamanho = texto === null ? 0 : Array.from(texto).length;
  if (texto === null || tamanho === 0 || tamanho > MOTIVO_MAXIMO || CARACTERE_CONTROLE.test(texto)) {
    throw HttpError.validacao([{ campo: 'body.motivo', codigo: 'MOTIVO_INVALIDO', mensagem: 'Motivo inválido' }]);
  }
  return texto;
}

/** Lê e trava ator e alvo em ordem crescente de id; devolve um mapa id → usuário (ou null). */
async function travarUsuarios(client, empresaId, ids) {
  const lidos = new Map();
  for (const id of [...new Set(ids)].sort((a, b) => a - b)) {
    lidos.set(id, await usuarioRepo.buscarPorIdParaAtualizacao(client, empresaId, id));
  }
  return lidos;
}

/**
 * A autoridade sobre os vínculos SST: o usuário ativo de perfil MASTER, lido
 * do banco. Exportada para as permissões efetivas (12G-0) mostrarem à tela a
 * mesma decisão que os endpoints tomam, sem regra paralela.
 */
function temAutoridadeVinculoSst(ator) {
  return ator !== null && ator !== undefined && ator.ativo === true && ator.perfil === PERFIL_MASTER;
}

function exigirAutoridade(ator) {
  if (!temAutoridadeVinculoSst(ator)) {
    throw HttpError.forbidden('SEM_AUTORIDADE_VINCULO_SST', 'Sem permissão para administrar o vínculo com a Segurança do Trabalho');
  }
}

/**
 * Concede o vínculo SST a um usuário ativo da própria empresa. O MASTER pode
 * administrar vínculos, mas não é alvo de um: a camada de autorização já o
 * trata por perfil, e um vínculo latente ganharia efeito se o perfil mudasse.
 * Vínculo legado de MASTER não é removido sozinho.
 *
 * @throws {HttpError} 400 motivo inválido; 403 ator sem autoridade; 404 usuário
 *   fora da empresa; 409 alvo MASTER, usuário inativo ou vínculo já existente
 */
async function concederVinculo(pool, {
  empresaId, atorId, usuarioId, motivo = null, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(usuarioId, 'identificador de usuário');
  const motivoN = motivoOpcional(motivo);

  return emTransacao(pool, async (client) => {
    const usuarios = await travarUsuarios(client, empresaId, [atorId, usuarioId]);
    exigirAutoridade(usuarios.get(atorId));
    const alvo = usuarios.get(usuarioId);
    if (alvo === null) throw HttpError.notFound('USUARIO_NAO_ENCONTRADO', 'Usuário não encontrado');
    if (alvo.perfil === PERFIL_MASTER) {
      throw HttpError.conflict('VINCULO_SST_NAO_SE_APLICA_AO_MASTER', 'O perfil MASTER dispensa o vínculo com a Segurança do Trabalho');
    }
    if (alvo.ativo !== true) throw HttpError.conflict('USUARIO_INATIVO', 'Usuário inativo não recebe vínculo com a Segurança do Trabalho');

    const criado = await vinculoRepo.inserir(client, { empresaId, usuarioId, concedidoPor: atorId, motivo: motivoN });
    if (criado === null) throw HttpError.conflict('VINCULO_SST_JA_EXISTE', 'O usuário já integra a Segurança do Trabalho');

    // O motivo fica só no vínculo; a auditoria registra se houve, nunca o texto.
    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_ADICIONADO,
      referencia: String(usuarioId),
      ip,
      dispositivo,
      contexto: { usuarioId, comMotivo: motivoN !== null },
      dadosNovos: { usuarioId, concedidoPor: atorId },
    });
    return {
      usuarioId: criado.usuarioId, concedidoPor: criado.concedidoPor, concedidoEm: criado.concedidoEm, motivo: criado.motivo,
    };
  });
}

/**
 * Remove o vínculo SST de um usuário da própria empresa, inclusive de usuário
 * inativado depois (limpeza).
 *
 * @throws {HttpError} 403 ator sem autoridade; 404 sem vínculo
 */
async function removerVinculo(pool, {
  empresaId, atorId, usuarioId, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(usuarioId, 'identificador de usuário');

  return emTransacao(pool, async (client) => {
    const usuarios = await travarUsuarios(client, empresaId, [atorId, usuarioId]);
    exigirAutoridade(usuarios.get(atorId));

    const removido = await vinculoRepo.remover(client, empresaId, usuarioId);
    if (removido === null) throw HttpError.notFound('VINCULO_SST_NAO_ENCONTRADO', 'O usuário não integra a Segurança do Trabalho');

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId: atorId,
      acao: ACAO_REMOVIDO,
      referencia: String(usuarioId),
      ip,
      dispositivo,
      contexto: { usuarioId },
      dadosAnteriores: { usuarioId, concedidoPor: removido.concedidoPor, concedidoEm: removido.concedidoEm },
    });
    return { usuarioId };
  });
}

/**
 * Lista os vínculos SST da própria empresa, do mais novo ao mais antigo, com
 * nome, perfil e situação do usuário: o vínculo de usuário inativo e o legado
 * de MASTER aparecem, para quem administra poder removê-los. Só o MASTER ativo
 * da empresa lê, com o mesmo 403 genérico de conceder e remover. Só leitura,
 * num retrato único do banco, sem auditoria.
 *
 * @throws {HttpError} 403 ator sem autoridade
 */
async function listarVinculos(pool, {
  empresaId, atorId, pagina, limite,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  if (!Number.isInteger(pagina) || pagina < 1) throw new TypeError('página inválida');
  if (!Number.isInteger(limite) || limite < 1 || limite > vinculoRepo.LIMITE_MAXIMO) throw new TypeError('limite inválido');

  return emLeitura(pool, async (client) => {
    exigirAutoridade(await usuarioRepo.buscarPorId(client, empresaId, atorId));
    const vinculos = await vinculoRepo.listarComUsuario(client, empresaId, { pagina, limite });
    const total = await vinculoRepo.contar(client, empresaId);
    return {
      vinculos, total, pagina, limite,
    };
  });
}

module.exports = {
  concederVinculo, removerVinculo, listarVinculos, temAutoridadeVinculoSst,
};
