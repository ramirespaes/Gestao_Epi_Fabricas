'use strict';

const { HttpError } = require('../errors/HttpError');
const funcionarioRepo = require('../repositories/funcionario.repository');
const gheRepo = require('../repositories/grupo-homogeneo-exposicao.repository');
const eventosRepo = require('../repositories/funcionario-eventos.repository');

/**
 * Histórico de eventos de um funcionário (pacote E: tipo GHE; pacote F: tipo SITUACAO; pacote G: tipo CADASTRAL), montado
 * campo a campo a partir da auditoria. No tipo SITUACAO, anterior/novo são 'ATIVO' | 'AFASTADO' | 'INATIVO' ou null (nada
 * inventado). No tipo CADASTRAL o evento traz `alteracoes: [{ campo, anterior, novo }]` no lugar de anterior/novo, só com
 * nome, matricula, setor, funcao e dataAdmissao (YYYY-MM-DD; fora do formato vira null). Pacote H: `de` e `ate`
 * (dias de São Paulo, inclusivos, opcionais) restringem a lista e o total, nos três tipos.
 *
 * O funcionário é conferido na empresa da sessão ANTES de qualquer leitura de eventos: inexistente e de outra empresa dão
 * o mesmo 404. Cada evento sai como { id, tipo, ocorridoEm, anterior, novo, responsavel }:
 *   tipo: CADASTRO | IMPORTACAO (registro inicial) | ALTERACAO;
 *   anterior/novo: null (sem GHE) ou { id, codigo, descricao } — código e descrição SÓ quando o evento os gravou
 *     (FUNCIONARIO_GHE_ALTERADO). Quando o evento gravou só o id, código e descrição vêm null e `atual` traz, à parte, a
 *     identificação ATUAL do GHE na empresa ({ codigo, descricao }, ou null se não houver): complemento, nunca histórico;
 *   responsavel: { id, nome atual } do usuário da empresa que agiu, ou null.
 */

const MSG_NAO_ENCONTRADO = 'Funcionário não encontrado';

const idValido = (v) => Number.isInteger(v) && v > 0;
const textoOuNulo = (v) => (typeof v === 'string' && v.trim() !== '' ? v : null);

/** GHE gravado com código e descrição (evento do S3). */
function gheHistorico(g) {
  if (g === null || g === undefined || typeof g !== 'object') return null;
  return { id: idValido(g.id) ? g.id : null, codigo: textoOuNulo(g.codigo), descricao: textoOuNulo(g.descricao) };
}

/** GHE gravado só pelo id: histórico vazio + identificação atual complementar. */
function gheSoId(id, atuais) {
  if (id === null || id === undefined) return null;
  if (!idValido(id)) return { id: null, codigo: null, descricao: null, atual: null };
  const a = atuais.get(id);
  return { id, codigo: null, descricao: null, atual: a ? { codigo: a.codigo ?? null, descricao: a.descricao ?? null } : null };
}

function tipoDe(linha) {
  if (linha.acao === 'FUNCIONARIO_CRIADO') return linha.origem === 'importacao' ? 'IMPORTACAO' : 'CADASTRO';
  return 'ALTERACAO';
}

const SITUACOES = ['ATIVO', 'AFASTADO', 'INATIVO'];
const situacaoOuNula = (v) => (SITUACOES.includes(v) ? v : null);

async function eventosDeSituacao(pool, empresaId, funcionarioId, { pagina, limite, de, ate }) {
  const [linhas, total] = await Promise.all([
    eventosRepo.listarSituacao(pool, empresaId, funcionarioId, { pagina, limite, de, ate }),
    eventosRepo.contarSituacao(pool, empresaId, funcionarioId, { de, ate }),
  ]);
  const eventos = linhas.map((l) => ({
    id: l.id,
    tipo: tipoDe(l),
    ocorridoEm: l.ocorridoEm,
    anterior: l.acao === 'FUNCIONARIO_CRIADO' ? null : situacaoOuNula(l.situacaoAnterior),
    novo: situacaoOuNula(l.situacaoNova),
    ...(typeof l.dataEfetiva === 'string' && DATA.test(l.dataEfetiva) ? { dataEfetiva: l.dataEfetiva } : {}),
    responsavel: l.responsavel,
  }));
  return { eventos, total };
}

// Mesmas regras do FILTRO_CADASTRAL do repositório: chave presente, valor texto ou null, mudança = anterior !== novo.
const DATA = /^\d{4}-\d{2}-\d{2}$/;
const temChave = (o, k) => o !== null && typeof o === 'object' && Object.hasOwn(o, k);

function valorCadastral(campo, v) {
  if (typeof v !== 'string') return null;
  if (campo === 'dataAdmissao') return DATA.test(v) ? v : null;
  return v;
}

function alteracoesDe(l) {
  const criado = l.acao === 'FUNCIONARIO_CRIADO';
  const alteracoes = [];
  for (const campo of eventosRepo.CAMPOS_CADASTRAIS) {
    if (criado) {
      if (temChave(l.novos, campo) && l.novos[campo] !== null) {
        alteracoes.push({ campo, anterior: null, novo: valorCadastral(campo, l.novos[campo]) });
      }
    } else if (temChave(l.anteriores, campo) && temChave(l.novos, campo) && l.anteriores[campo] !== l.novos[campo]) {
      alteracoes.push({ campo, anterior: valorCadastral(campo, l.anteriores[campo]), novo: valorCadastral(campo, l.novos[campo]) });
    }
  }
  return alteracoes;
}

async function eventosCadastrais(pool, empresaId, funcionarioId, { pagina, limite, de, ate }) {
  const [linhas, total] = await Promise.all([
    eventosRepo.listarCadastral(pool, empresaId, funcionarioId, { pagina, limite, de, ate }),
    eventosRepo.contarCadastral(pool, empresaId, funcionarioId, { de, ate }),
  ]);
  const eventos = linhas.map((l) => ({
    id: l.id,
    tipo: tipoDe(l),
    ocorridoEm: l.ocorridoEm,
    alteracoes: alteracoesDe(l),
    responsavel: l.responsavel,
  }));
  return { eventos, total };
}

const TIPOS = ['GHE', 'SITUACAO', 'CADASTRAL'];

async function listarEventos(pool, {
  empresaId, funcionarioId, tipo, de = null, ate = null, pagina, limite,
}) {
  if (!TIPOS.includes(tipo)) throw new TypeError('tipo de evento inválido');
  const funcionario = await funcionarioRepo.buscarPorId(pool, empresaId, funcionarioId);
  if (funcionario === null) throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', MSG_NAO_ENCONTRADO);

  if (tipo === 'SITUACAO' || tipo === 'CADASTRAL') {
    const ler = tipo === 'SITUACAO' ? eventosDeSituacao : eventosCadastrais;
    const { eventos, total } = await ler(pool, empresaId, funcionarioId, { pagina, limite, de, ate });
    return { funcionarioId, tipo, eventos, total, pagina, limite };
  }

  const [linhas, total] = await Promise.all([
    eventosRepo.listarGhe(pool, empresaId, funcionarioId, { pagina, limite, de, ate }),
    eventosRepo.contarGhe(pool, empresaId, funcionarioId, { de, ate }),
  ]);

  const soIds = linhas.filter((l) => l.acao !== 'FUNCIONARIO_GHE_ALTERADO')
    .flatMap((l) => [l.gheIdAnterior, l.gheIdNovo]).filter(idValido);
  const atuais = await gheRepo.resumirPorIds(pool, empresaId, [...new Set(soIds)]);

  const eventos = linhas.map((l) => {
    const historico = l.acao === 'FUNCIONARIO_GHE_ALTERADO';
    return {
      id: l.id,
      tipo: tipoDe(l),
      ocorridoEm: l.ocorridoEm,
      anterior: l.acao === 'FUNCIONARIO_CRIADO' ? null : (historico ? gheHistorico(l.gheAnterior) : gheSoId(l.gheIdAnterior, atuais)),
      novo: historico ? gheHistorico(l.gheNovo) : gheSoId(l.gheIdNovo, atuais),
      responsavel: l.responsavel,
    };
  });

  return { funcionarioId, tipo, eventos, total, pagina, limite };
}

module.exports = { listarEventos };
