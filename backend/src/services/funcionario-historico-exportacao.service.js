'use strict';

const crypto = require('node:crypto');
const { HttpError } = require('../errors/HttpError');
const autorizacao = require('../middleware/autorizacao');
const exportacaoAutorizacao = require('./exportacao-historico-autorizacao.service');
const funcionarioService = require('./funcionario.service');
const eventosService = require('./funcionario-eventos.service');
const consultaEntregas = require('./entrega-epi-consulta.service');
const empresaRepo = require('../repositories/empresa.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const exportacaoRepo = require('../repositories/exportacao-historico.repository');
const { FORMATOS } = require('./exportacao-historico/formatos');
const { renderizarPdf } = require('./exportacao-historico/pdf');
const { renderizarXlsx } = require('./exportacao-historico/xlsx');

/**
 * Exportação do Histórico de Funcionários (pacote I), em PDF e XLSX.
 *
 * montar(): o MODELO do documento, com a autorização do pacote J (visualizar E exportar, sempre avaliadas aqui, nunca
 * vindas do cliente) ANTES de qualquer leitura; depois o mesmo 404 para inexistente e de outra empresa. Lê os mesmos
 * serviços das telas (A–H), TODAS as páginas, no período do pacote H. Sem epiFicha.visualizar, entregas e indicadores
 * ficam null e nada de EPI é consultado. Uma seção acima de LIMITE_POR_SECAO registros recusa a exportação inteira (422),
 * nunca um arquivo truncado. Os indicadores são sempre do histórico completo.
 *
 * exportar(): numa transação, sob advisory lock do usuário: autorização, funcionário, limite de exportações por minuto
 * (contado na auditoria, então vale entre instâncias), modelo, geração do arquivo em memória e, só com o arquivo pronto,
 * a auditoria FUNCIONARIO_HISTORICO_EXPORTADO com o SHA-256 dos bytes devolvidos. Falha na geração não audita.
 */

const ACAO_AUDITORIA = 'FUNCIONARIO_HISTORICO_EXPORTADO';
const LIMITE_POR_SECAO = 5000;
const LIMITE_POR_MINUTO = 10;
const JANELA_SEGUNDOS = 60;
const PAGINA = 100;
const ESPACO_LOCK = 'exportacao_historico_funcionario';
const TIPOS_EVENTO = ['GHE', 'SITUACAO', 'CADASTRAL'];
const RENDERIZADORES = Object.freeze({ pdf: renderizarPdf, xlsx: renderizarXlsx });

const MSG = Object.freeze({
  NAO_AUTORIZADA: 'Sem permissão para exportar o histórico deste funcionário',
  GRANDE_DEMAIS: 'O histórico tem registros demais para um arquivo. Escolha um período menor.',
  LIMITE: 'Muitas exportações em pouco tempo. Aguarde um minuto e tente de novo.',
  FALHA: 'Não foi possível gerar o arquivo da exportação',
});

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

function grandeDemais() {
  return new HttpError(422, 'EXPORTACAO_GRANDE_DEMAIS', MSG.GRANDE_DEMAIS);
}

/** Todas as páginas de um leitor paginado; recusa antes de ler tudo quando o total passa do limite. */
async function todasAsPaginas(ler, chave, limitePorSecao) {
  const primeira = await ler(1);
  if (primeira.total > limitePorSecao) throw grandeDemais();
  const itens = [...primeira[chave]];
  for (let pagina = 2; itens.length < primeira.total; pagina += 1) {
    const r = await ler(pagina);
    if (r[chave].length === 0) break;
    itens.push(...r[chave]);
  }
  return itens;
}

// Só o que o documento mostra: sem CPF nem cadastro atual do trabalhador, sem empresa/CNPJ, sem assinatura.
const entregaDoDocumento = (e) => ({
  id: e.id,
  dataOperacional: e.dataOperacional,
  entregueEm: e.entregueEm,
  origem: e.origem,
  responsavel: { nome: e.responsavel?.nome ?? null },
  ghe: e.ghe ? { nome: e.ghe.nome ?? null } : null,
  itens: e.itens.map((i) => ({
    material: { nome: i.material?.nome ?? null, tipo: i.material?.tipo ?? null },
    tamanho: i.lote?.tamanho ?? null,
    quantidade: i.quantidade,
    caNumero: i.lote?.caNumero ?? null,
    caValidade: i.lote?.caValidade ?? null,
    prazoUsoDias: i.material?.prazoUsoDias ?? null,
    motivo: i.motivo,
  })),
});

async function autorizar(executor, ctx) {
  const decisao = await exportacaoAutorizacao.avaliar(executor, ctx);
  if (!decisao.permitido) throw HttpError.forbidden('EXPORTACAO_NAO_AUTORIZADA', MSG.NAO_AUTORIZADA);
}

async function montar(executor, {
  empresaId, usuarioId, perfil, funcionarioId, de = null, ate = null,
}, { limitePorSecao = LIMITE_POR_SECAO } = {}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  exigirId(funcionarioId, 'identificador de funcionário');
  if ((de === null) !== (ate === null)) throw new TypeError('período incompleto');
  const ctx = { empresaId, usuarioId, perfil };
  await autorizar(executor, ctx);
  const funcionario = await funcionarioService.buscar(executor, { empresaId, funcionarioId });

  const periodo = de === null ? null : { de, ate };
  const eventos = {};
  for (const tipo of TIPOS_EVENTO) {
    eventos[tipo] = await todasAsPaginas((pagina) => eventosService.listarEventos(executor, {
      empresaId, funcionarioId, tipo, de, ate, pagina, limite: PAGINA,
    }), 'eventos', limitePorSecao);
  }

  const veEpis = (await autorizacao.avaliarPermissaoRecurso(executor, ctx, 'epiFicha')).visualizar === true;
  let indicadores = null;
  let entregas = null;
  if (veEpis) {
    const { fichas } = await consultaEntregas.listarFichas(executor, { empresaId, funcionarioId, pagina: 1, limite: 1 });
    const ficha = fichas.find((f) => f.funcionarioId === funcionarioId) ?? null;
    if (ficha === null) {
      indicadores = { totalEntregas: 0, episDistintos: 0, ultimaEntregaEm: null, episDentroPrazoUso: 0 };
      entregas = [];
    } else {
      const r = ficha.resumo;
      indicadores = {
        totalEntregas: r.totalEntregas, episDistintos: r.episDistintos, ultimaEntregaEm: r.ultimaEntregaEm, episDentroPrazoUso: r.episDentroPrazoUso,
      };
      entregas = (await todasAsPaginas((pagina) => consultaEntregas.listarEntregasDaFicha(executor, {
        empresaId, fichaId: ficha.id, de, ate, pagina, limite: PAGINA,
      }), 'entregas', limitePorSecao)).map(entregaDoDocumento);
    }
  }

  const empresa = await empresaRepo.buscarPorId(executor, empresaId);
  const secoes = ['identificacao', ...(veEpis ? ['indicadores', 'entregas'] : []), 'ghe', 'situacao', 'cadastral'];
  return {
    empresa: { nome: empresa?.nome ?? null },
    emitidoEm: new Date().toISOString(),
    periodo,
    funcionario: {
      id: funcionario.id,
      nome: funcionario.nome,
      matricula: funcionario.matricula,
      setor: funcionario.setor,
      funcao: funcionario.funcao,
      situacao: funcionario.situacao,
      ghe: funcionario.grupoHomogeneo
        ? { codigo: funcionario.grupoHomogeneo.codigo ?? null, descricao: funcionario.grupoHomogeneo.descricao ?? null }
        : null,
    },
    indicadores,
    entregas,
    ghe: eventos.GHE,
    situacao: eventos.SITUACAO,
    cadastral: eventos.CADASTRAL,
    secoes,
  };
}

function lockDoUsuario(empresaId, usuarioId) {
  return crypto.createHash('sha256').update(`${ESPACO_LOCK}\n${empresaId}\n${usuarioId}`).digest().readBigInt64BE(0).toString();
}

const nomeDoArquivo = (funcionarioId, periodo, extensao) => {
  const escopo = periodo ? `${periodo.de.replace(/-/g, '')}-${periodo.ate.replace(/-/g, '')}` : 'completo';
  return `historico-funcionario-${funcionarioId}-${escopo}.${extensao}`;
};

async function exportar(pool, {
  empresaId, usuarioId, perfil, funcionarioId, formato, de = null, ate = null, ip = null, dispositivo = null,
}, { renderizadores = RENDERIZADORES, limitePorSecao = LIMITE_POR_SECAO, limitePorMinuto = LIMITE_POR_MINUTO } = {}) {
  const definicao = FORMATOS.find((f) => f.id === formato);
  if (!definicao) throw new TypeError('formato de exportação inválido');
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  exigirId(funcionarioId, 'identificador de funcionário');

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [lockDoUsuario(empresaId, usuarioId)]);
    const ctx = { empresaId, usuarioId, perfil };
    await autorizar(client, ctx);
    await funcionarioService.buscar(client, { empresaId, funcionarioId });
    const recentes = await exportacaoRepo.contarRecentes(client, {
      empresaId, usuarioId, acao: ACAO_AUDITORIA, janelaSegundos: JANELA_SEGUNDOS,
    });
    if (recentes >= limitePorMinuto) throw HttpError.tooManyRequests('EXPORTACAO_LIMITE_EXCEDIDO', MSG.LIMITE);

    const modelo = await montar(client, {
      ...ctx, funcionarioId, de, ate,
    }, { limitePorSecao });

    let conteudo;
    try {
      conteudo = await renderizadores[definicao.id](modelo);
    } catch {
      throw new HttpError(500, 'EXPORTACAO_FALHOU', MSG.FALHA);
    }
    if (!Buffer.isBuffer(conteudo) || conteudo.length === 0) throw new HttpError(500, 'EXPORTACAO_FALHOU', MSG.FALHA);
    const sha256 = crypto.createHash('sha256').update(conteudo).digest('hex');

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId,
      acao: ACAO_AUDITORIA,
      referencia: String(funcionarioId),
      ip,
      dispositivo,
      dadosNovos: {
        formato: definicao.id,
        periodo: modelo.periodo,
        secoes: modelo.secoes,
        contagens: {
          entregas: modelo.entregas === null ? null : modelo.entregas.length,
          ghe: modelo.ghe.length,
          situacao: modelo.situacao.length,
          cadastral: modelo.cadastral.length,
        },
        bytes: conteudo.length,
        sha256,
      },
    });
    await client.query('COMMIT');
    return {
      conteudo, nomeArquivo: nomeDoArquivo(funcionarioId, modelo.periodo, definicao.extensao), mime: definicao.mime, sha256, bytes: conteudo.length,
    };
  } catch (erro) {
    await client.query('ROLLBACK').catch(() => {});
    throw erro;
  } finally {
    client.release();
  }
}

module.exports = {
  FORMATOS, montar, exportar, ACAO_AUDITORIA, LIMITE_POR_SECAO, LIMITE_POR_MINUTO,
};
