'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const autoridade = require('./autoridade-administrativa');
const cooldown = require('../security/cooldown');
const repo = require('../repositories/usuario-administracao.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');

/**
 * Administração de usuários da empresa (Bloco 9, parte F): listar,
 * consultar, alterar nome e perfil, inativar e reativar.
 *
 * AUTORIDADE (D2): o ponto único de autoridade-administrativa.js, ação
 * GERENCIAR_USUARIOS (047). MASTER ativo por perfil, ou ADMINISTRADOR
 * ativo com autorização individual própria. Nenhum atalho por perfil aqui.
 *
 * PERFIS (D3): só o MASTER gerencia MASTER e ADMINISTRADOR. O
 * ADMINISTRADOR autorizado gerencia apenas SUPERVISOR e USUARIO, tanto o
 * perfil atual do alvo quanto o perfil novo.
 *
 * ÚLTIMO MASTER: tirar a condição de MASTER ativo de alguém (inativar ou
 * mudar o perfil) exige que reste outro MASTER ativo. Duas travas, nesta
 * ordem, em toda escrita: uma trava consultiva por empresa, que põe em
 * fila as escritas de usuários da mesma empresa (sem ciclo de espera entre
 * elas), e o FOR UPDATE de todos os MASTERs ativos antes de contar.
 *
 * ISOLAMENTO: a empresa vem da sessão. Usuário de outra empresa responde
 * 404 idêntico ao inexistente. A auditoria anda na mesma transação e
 * guarda só o campo que mudou.
 */

const PERFIL_MASTER = 'MASTER';
const PERFIS_DO_MASTER = Object.freeze(['MASTER', 'ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']);
const PERFIS_DO_ADMINISTRADOR = Object.freeze(['SUPERVISOR', 'USUARIO']);
const TAMANHO_MAXIMO_IP = 45;
const TAMANHO_MAXIMO_DISPOSITIVO = 150;
const ORIGEM_AUDITORIA = Object.freeze({ origem: 'administracao_usuarios' });

const ACAO = Object.freeze({
  ALTERADO: 'USUARIO_ALTERADO',
  PERFIL_ALTERADO: 'USUARIO_PERFIL_ALTERADO',
  INATIVADO: 'USUARIO_INATIVADO',
  REATIVADO: 'USUARIO_REATIVADO',
});

const ERRO = Object.freeze({
  NAO_AUTORIZADO: ['USUARIO_ADMINISTRACAO_NAO_AUTORIZADA', 'Sem autoridade para administrar os usuários da empresa'],
  PERFIL: ['USUARIO_PERFIL_NAO_PERMITIDO', 'Somente o MASTER gerencia usuários MASTER e ADMINISTRADOR'],
  NAO_ENCONTRADO: ['USUARIO_NAO_ENCONTRADO', 'Usuário não encontrado'],
  JA_INATIVO: ['USUARIO_JA_INATIVO', 'O usuário já está inativo'],
  JA_ATIVO: ['USUARIO_JA_ATIVO', 'O usuário já está ativo'],
  ULTIMO_MASTER: ['USUARIO_ULTIMO_MASTER', 'A empresa precisa continuar com pelo menos um MASTER ativo'],
});

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function cortar(valor, tamanhoMaximo) {
  if (typeof valor !== 'string') {
    return null;
  }
  return valor.length > tamanhoMaximo ? valor.slice(0, tamanhoMaximo) : valor;
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

/** Não é segredo: SHA-256 simples, como a trava de criação de convite. */
function travaDaEmpresa(empresaId) {
  const digest = crypto.createHash('sha256').update(`USUARIOS_ADMINISTRACAO\n${empresaId}`, 'utf8').digest('hex');
  return cooldown.derivarAdvisoryLock64(digest);
}

function perfisGerenciaveis(ator) {
  return ator.perfil === PERFIL_MASTER ? PERFIS_DO_MASTER : PERFIS_DO_ADMINISTRADOR;
}

function exigirPerfilGerenciavel(ator, perfil) {
  if (!perfisGerenciaveis(ator).includes(perfil)) {
    throw HttpError.forbidden(...ERRO.PERFIL);
  }
}

const apresentar = (usuario, ator) => ({
  ...usuario,
  podeGerenciar: perfisGerenciaveis(ator).includes(usuario.perfil),
  proprio: usuario.id === ator.id,
});

const exigirLeitura = (pool, empresaId, atorId) => autoridade.exigirAutoridadeAdministrativaLeitura(
  pool, empresaId, atorId, ...ERRO.NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.USUARIOS,
);

async function listar(pool, {
  empresaId, atorId, busca = null, situacao = null, perfil = null, ordem = 'nome', pagina = 1, limite = 20,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  const ator = await exigirLeitura(pool, empresaId, atorId);

  const { usuarios, total } = await repo.listar(pool, empresaId, {
    busca, situacao, perfil, ordem, pagina, limite,
  });
  const mastersAtivos = await repo.contarMastersAtivos(pool, empresaId);

  return {
    usuarios: usuarios.map((usuario) => apresentar(usuario, ator)),
    total,
    pagina,
    limite,
    paginas: Math.ceil(total / limite),
    mastersAtivos,
    perfisGerenciaveis: [...perfisGerenciaveis(ator)],
  };
}

async function buscar(pool, { empresaId, atorId, usuarioId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(usuarioId, 'identificador de usuário');
  const ator = await exigirLeitura(pool, empresaId, atorId);
  const usuario = await repo.buscarPorId(pool, empresaId, usuarioId);
  if (usuario === null) {
    throw HttpError.notFound(...ERRO.NAO_ENCONTRADO);
  }
  return apresentar(usuario, ator);
}

/**
 * Esqueleto comum das escritas: trava da empresa, autoridade (com o ator
 * travado), alvo travado e na mesma empresa, e D3 sobre o perfil atual do
 * alvo. `operacao` decide o resto dentro da mesma transação.
 */
async function escrever(pool, { empresaId, atorId, usuarioId }, operacao) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(usuarioId, 'identificador de usuário');

  return emTransacao(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [travaDaEmpresa(empresaId)]);
    const ator = await autoridade.exigirAutoridadeAdministrativa(
      client, empresaId, atorId, ...ERRO.NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.USUARIOS,
    );
    const alvo = await repo.buscarParaAtualizacao(client, empresaId, usuarioId);
    if (alvo === null) {
      throw HttpError.notFound(...ERRO.NAO_ENCONTRADO);
    }
    exigirPerfilGerenciavel(ator, alvo.perfil);
    return operacao(client, ator, alvo);
  });
}

/** Antes de o alvo deixar de ser MASTER ativo: precisa restar outro. */
async function exigirOutroMasterAtivo(client, empresaId, alvo) {
  const masters = await repo.travarMastersAtivos(client, empresaId);
  if (!masters.some((id) => id !== alvo.id)) {
    throw HttpError.conflict(...ERRO.ULTIMO_MASTER);
  }
}

const deixaDeSerMasterAtivo = (alvo) => alvo.perfil === PERFIL_MASTER && alvo.ativo === true;

async function registrar(client, { empresaId, atorId, acao, alvoId, ip, dispositivo, antes, depois }) {
  await auditoriaRepo.registrar(client, {
    empresaId,
    usuarioId: atorId,
    acao,
    referencia: String(alvoId),
    ip: cortar(ip, TAMANHO_MAXIMO_IP),
    dispositivo: cortar(dispositivo, TAMANHO_MAXIMO_DISPOSITIVO),
    contexto: { ...ORIGEM_AUDITORIA },
    dadosAnteriores: antes,
    dadosNovos: depois,
  });
}

/**
 * Altera o nome e/ou o perfil do vínculo. E-mail, empresa, situação e
 * grupo não passam por aqui. Valor igual ao atual não muda nada nem audita.
 * @returns {Promise<{usuario: object, alterado: boolean}>}
 */
async function alterar(pool, {
  empresaId, atorId, usuarioId, nome, perfil, ip = null, dispositivo = null,
}) {
  return escrever(pool, { empresaId, atorId, usuarioId }, async (client, ator, alvo) => {
    if (perfil !== undefined) {
      exigirPerfilGerenciavel(ator, perfil);
    }
    const mudaNome = nome !== undefined && nome !== alvo.nome;
    const mudaPerfil = perfil !== undefined && perfil !== alvo.perfil;
    const base = { empresaId, atorId: ator.id, alvoId: alvo.id, ip, dispositivo };

    if (mudaPerfil && deixaDeSerMasterAtivo(alvo)) {
      await exigirOutroMasterAtivo(client, empresaId, alvo);
    }
    if (mudaNome) {
      await repo.atualizarNome(client, empresaId, alvo.id, nome);
      await registrar(client, { ...base, acao: ACAO.ALTERADO, antes: { nome: alvo.nome }, depois: { nome } });
    }
    if (mudaPerfil) {
      await repo.atualizarPerfil(client, empresaId, alvo.id, perfil);
      await registrar(client, { ...base, acao: ACAO.PERFIL_ALTERADO, antes: { perfil: alvo.perfil }, depois: { perfil } });
    }

    const usuario = await repo.buscarPorId(client, empresaId, alvo.id);
    return { usuario: apresentar(usuario, ator), alterado: mudaNome || mudaPerfil };
  });
}

/**
 * Inativação lógica: o vínculo e o histórico ficam. O trigger da 038
 * revoga as sessões deste vínculo nesta empresa; a identidade e os
 * vínculos em outras empresas não mudam.
 */
async function inativar(pool, {
  empresaId, atorId, usuarioId, ip = null, dispositivo = null,
}) {
  return escrever(pool, { empresaId, atorId, usuarioId }, async (client, ator, alvo) => {
    if (alvo.ativo !== true) {
      throw HttpError.conflict(...ERRO.JA_INATIVO);
    }
    if (deixaDeSerMasterAtivo(alvo)) {
      await exigirOutroMasterAtivo(client, empresaId, alvo);
    }
    await repo.definirAtivo(client, empresaId, alvo.id, false);
    await registrar(client, {
      empresaId, atorId: ator.id, alvoId: alvo.id, ip, dispositivo, acao: ACAO.INATIVADO, antes: { ativo: true }, depois: { ativo: false },
    });
    return apresentar(await repo.buscarPorId(client, empresaId, alvo.id), ator);
  });
}

/** Reativa o MESMO vínculo: nenhum vínculo novo nasce. */
async function reativar(pool, {
  empresaId, atorId, usuarioId, ip = null, dispositivo = null,
}) {
  return escrever(pool, { empresaId, atorId, usuarioId }, async (client, ator, alvo) => {
    if (alvo.ativo === true) {
      throw HttpError.conflict(...ERRO.JA_ATIVO);
    }
    await repo.definirAtivo(client, empresaId, alvo.id, true);
    await registrar(client, {
      empresaId, atorId: ator.id, alvoId: alvo.id, ip, dispositivo, acao: ACAO.REATIVADO, antes: { ativo: false }, depois: { ativo: true },
    });
    return apresentar(await repo.buscarPorId(client, empresaId, alvo.id), ator);
  });
}

module.exports = {
  listar,
  buscar,
  alterar,
  inativar,
  reativar,
  perfisGerenciaveis,
  ACAO,
  PERFIS_DO_MASTER,
  PERFIS_DO_ADMINISTRADOR,
};
