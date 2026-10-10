'use strict';

const { HttpError } = require('../errors/HttpError');
const tipoRepo = require('../repositories/tipo-material.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const classificacao = require('../utils/classificacao-material');

/**
 * Catálogo de tipos de material (classificação V2). Autorização mora no middleware (recurso `materials`):
 * aqui só isolamento (empresa sempre da sessão), validação de domínio, transação e auditoria — mesmo desenho de
 * material.service.js. Sem exclusão: tipo é inativado (o material que o usa continua íntegro). Importação em massa
 * ficou fora do escopo (decisão de 08/10/2026).
 */

const VIOLACAO_UNIQUE = '23505';
const ACAO = Object.freeze({ CRIADO: 'TIPO_MATERIAL_CRIADO', INATIVADO: 'TIPO_MATERIAL_INATIVADO', REATIVADO: 'TIPO_MATERIAL_REATIVADO' });
const MSG = Object.freeze({
  GRUPO: 'Grupo inválido: use EPI ou Vestimenta',
  PROTECAO: 'Grupo de proteção inválido',
  NOME: 'Nome do tipo inválido (1 a 100 caracteres, sem caracteres de controle)',
  OUTROS: '"Outros" é reservado: informe o nome real do tipo',
  JA_EXISTE: 'Já existe um tipo com este nome neste grupo',
  NAO_ENCONTRADO: 'Tipo de material não encontrado',
});
const CARACTERE_CONTROLE = /\p{Cc}/u;
const NOME_MAXIMO = 100;

const recusar = (campo, codigo, mensagem) => HttpError.validacao([{ campo, codigo, mensagem }]);

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

function vocabulario() {
  return { grupos: [...classificacao.GRUPOS_CATALOGO], gruposProtecao: [...classificacao.GRUPOS_PROTECAO] };
}

/** Grupo, proteção e nome prontos para gravar, ou 400 com o campo do problema. */
function validarTipo({ grupo, grupoProtecao, nome }) {
  if (!classificacao.GRUPOS_CATALOGO.includes(grupo)) throw recusar('body.grupo', 'GRUPO_INVALIDO', MSG.GRUPO);
  if (!classificacao.GRUPOS_PROTECAO.includes(grupoProtecao)) throw recusar('body.grupoProtecao', 'GRUPO_PROTECAO_INVALIDO', MSG.PROTECAO);
  const nomeN = classificacao.normalizarNomeTipo(nome).normalize('NFC');
  if (nomeN.length === 0 || Array.from(nomeN).length > NOME_MAXIMO || CARACTERE_CONTROLE.test(nomeN)) throw recusar('body.nome', 'NOME_INVALIDO', MSG.NOME);
  if (classificacao.chaveDoTipo(nomeN) === classificacao.OUTROS.toLowerCase()) throw recusar('body.nome', 'TIPO_MATERIAL_OUTROS_RESERVADO', MSG.OUTROS);
  return { grupo, grupoProtecao, nome: nomeN };
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

async function listar(pool, { empresaId, grupo = null, grupoProtecao = null, ativo = null, busca = null, pagina = 1, limite = 20 }) {
  exigirId(empresaId, 'identificador de empresa');
  const f = { grupo, grupoProtecao, ativo, busca };
  const [tipos, total] = await Promise.all([tipoRepo.listar(pool, empresaId, { ...f, pagina, limite }), tipoRepo.contar(pool, empresaId, f)]);
  return { tipos, total, pagina, limite, vocabulario: vocabulario() };
}

async function criar(pool, { empresaId, atorId, grupo, grupoProtecao, nome, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  const dados = validarTipo({ grupo, grupoProtecao, nome });
  return emTransacao(pool, async (client) => {
    let tipo;
    try {
      tipo = await tipoRepo.criar(client, { empresaId, ...dados, origem: 'MANUAL' });
    } catch (erro) {
      if (erro.code === VIOLACAO_UNIQUE) throw HttpError.conflict('TIPO_MATERIAL_JA_EXISTE', MSG.JA_EXISTE);
      throw erro;
    }
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO.CRIADO, referencia: String(tipo.id), ip, dispositivo,
      contexto: { grupo: tipo.grupo, grupoProtecao: tipo.grupoProtecao, nome: tipo.nome, origem: tipo.origem },
    });
    return tipo;
  });
}

/** Idempotente: pedir o estado que o tipo já tem não grava nem audita. */
async function alterarEstado(pool, { empresaId, atorId, tipoId, ativo, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(tipoId, 'identificador de tipo');
  return emTransacao(pool, async (client) => {
    const anterior = await tipoRepo.buscarPorIdParaAtualizacao(client, empresaId, tipoId);
    if (anterior === null) throw HttpError.notFound('TIPO_MATERIAL_NAO_ENCONTRADO', MSG.NAO_ENCONTRADO);
    if (anterior.ativo === ativo) return { tipo: anterior, alterado: false };
    const atualizado = await tipoRepo.atualizarAtivo(client, empresaId, tipoId, ativo);
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ativo ? ACAO.REATIVADO : ACAO.INATIVADO, referencia: String(tipoId), ip, dispositivo,
      dadosAnteriores: { ativo: anterior.ativo }, dadosNovos: { ativo: atualizado.ativo },
    });
    return { tipo: atualizado, alterado: true };
  });
}

const inativar = (pool, dados) => alterarEstado(pool, { ...dados, ativo: false });
const reativar = (pool, dados) => alterarEstado(pool, { ...dados, ativo: true });

/** Catálogo base da empresa nova (dentro da transação do cadastro da empresa). */
function semearCatalogoBase(executor, empresaId) {
  return tipoRepo.semearCatalogoBase(executor, empresaId, classificacao.CATALOGO_BASE);
}

module.exports = { listar, criar, inativar, reativar, semearCatalogoBase, vocabulario, validarTipo };
