'use strict';

const crypto = require('node:crypto');
const importacaoRepo = require('../repositories/ghe-importacao.repository');
const gheRepo = require('../repositories/grupo-homogeneo-exposicao.repository');
const gheTipoRepo = require('../repositories/ghe-tipo-material.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { instantaneo } = require('./grupo-homogeneo-exposicao.service');
const { analisarLote } = require('../utils/ghe-importacao');

/**
 * Serviço da importação GHE/EPI.
 *
 * PREVIEW (5B): read-only. As três leituras (GHEs, tipos, vínculos da empresa) acontecem numa transação REPEATABLE READ
 * READ ONLY: uma fotografia consistente, sem lock de escrita, e o próprio banco recusa escrita nela. Nada é gravado.
 *
 * CONFIRMAÇÃO (5C): recebe de novo as linhas ORIGINAIS e não confia em nenhum preview. Numa ÚNICA transação:
 *   1. trava de transação por empresa só desta confirmação (importações da mesma empresa se serializam; o resto do sistema
 *      e as outras empresas não esperam) — a segunda confirmação concorrente enxerga o resultado da primeira;
 *   2. lê a fotografia (3 consultas) e roda o núcleo (utils/ghe-importacao.js, a MESMA regra do preview);
 *   3. se há o que gravar, trava as linhas que serão tocadas na mesma ordem do resto do sistema (GHE, depois tipo), relê o
 *      que ficou travado e roda o núcleo de novo com essas versões: a decisão final é sobre o estado travado;
 *   4. grava GHEs novos, códigos de legados e, por linha, vínculos (cada um relido com FOR UPDATE, e o INSERT usa ON CONFLICT
 *      como no CRUD de vínculo: o que outra operação criou no intervalo vira alteração ou no-op sobre o estado real);
 *   5. audita na mesma transação (eventos individuais ligados pelo importacaoId e UM evento de lote, só com contadores).
 * Qualquer erro inesperado = ROLLBACK de tudo. Conflito de negócio de uma linha não derruba as outras: ela só é reportada.
 * A importação é aditiva/corretiva: nunca exclui, inativa, reativa nem renumera, e não cria tipo, material nem ghe_materiais.
 * Os contadores contam o que foi REALMENTE persistido nesta transação.
 */

const ACAO_GHE_CRIADO = 'GHE_CRIADO';
const ACAO_GHE_ALTERADO = 'GHE_ALTERADO';
const ACAO_VINCULO = 'GHE_TIPO_MATERIAL_VINCULADO';
const ACAO_ALTERACAO = 'GHE_TIPO_MATERIAL_ALTERADO';
const ACAO_LOTE = 'GHE_IMPORTACAO_LOTE';
const ORIGEM = 'IMPORTACAO_GHE_EPI';

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

/** Fotografia da empresa em lote: uma consulta por assunto, nunca uma por linha. */
async function lerFotografia(executor, empresaId) {
  return {
    ghes: await importacaoRepo.listarGhes(executor, empresaId),
    tipos: await importacaoRepo.listarTipos(executor, empresaId),
    vinculos: await importacaoRepo.listarVinculos(executor, empresaId),
  };
}

async function previa(pool, { empresaId, linhas }) {
  exigirId(empresaId, 'identificador de empresa');
  if (!Array.isArray(linhas)) {
    throw new TypeError('linhas deve ser uma lista');
  }

  const client = await pool.connect();
  let fotografia;
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      fotografia = await lerFotografia(client, empresaId);
    } finally {
      await client.query('ROLLBACK');
    }
  } finally {
    client.release();
  }

  return analisarLote({ linhas, ...fotografia });
}

const temOperacoes = (analise) => analise.resumo.aplicaveis > 0 || analise.ghes.some((g) => g.operacao !== null);

/** As versões travadas substituem as da fotografia; o que sumiu da lista travada deixa de existir para a análise. */
function mesclar(fotografia, travados, ids) {
  const idsTravados = new Set(ids);
  return [...fotografia.filter((x) => !idsTravados.has(x.id)), ...travados];
}

/** Cria ou atualiza UM vínculo sobre o estado real (relido com FOR UPDATE). Devolve 'CRIADO' | 'ALTERADO' | 'SEM_ALTERACAO'. */
async function aplicarVinculo(client, base, { gheId, tipoId, classificacao }) {
  const dados = { grupoHomogeneoId: gheId, tipoMaterialId: tipoId };
  let existente = await gheTipoRepo.buscarParaAtualizacao(client, { empresaId: base.empresaId, gheId, tipoId });
  if (existente === null) {
    const criado = await gheTipoRepo.inserirSeAusente(client, { empresaId: base.empresaId, gheId, tipoId, classificacao });
    if (criado !== null) {
      await auditoriaRepo.registrar(client, {
        empresaId: base.empresaId, usuarioId: base.atorId, acao: ACAO_VINCULO, referencia: String(gheId), ip: base.ip, dispositivo: base.dispositivo,
        contexto: base.contexto, dadosNovos: { ...dados, classificacao },
      });
      return 'CRIADO';
    }
    // Outra operação criou o vínculo no intervalo: segue sobre o estado dela.
    existente = await gheTipoRepo.buscarParaAtualizacao(client, { empresaId: base.empresaId, gheId, tipoId });
    if (existente === null) {
      throw new Error('vínculo GHE × tipo instável durante a importação');
    }
  }
  if (existente.classificacao === classificacao) return 'SEM_ALTERACAO';
  const atualizado = await gheTipoRepo.atualizarClassificacao(client, { empresaId: base.empresaId, gheId, tipoId, classificacao });
  await auditoriaRepo.registrar(client, {
    empresaId: base.empresaId, usuarioId: base.atorId, acao: ACAO_ALTERACAO, referencia: String(gheId), ip: base.ip, dispositivo: base.dispositivo,
    contexto: base.contexto, dadosAnteriores: { ...dados, classificacao: existente.classificacao }, dadosNovos: { ...dados, classificacao: atualizado.classificacao },
  });
  return 'ALTERADO';
}

/** Grava o que a análise decidiu (dentro da transação do chamador) e devolve o resultado real, linha a linha. */
async function executar(client, base, analise, ghesTravados) {
  const idsCriados = new Map();
  const resultadoDoGhe = new Map();
  const contadores = { ghesCriados: 0, ghesComCodigoAtribuido: 0, vinculosCriados: 0, classificacoesAlteradas: 0 };

  for (const ghe of analise.ghes) {
    if (ghe.operacao === 'CRIAR') {
      const criado = await gheRepo.criar(client, { empresaId: base.empresaId, nome: ghe.descricao, codigo: ghe.codigo });
      await auditoriaRepo.registrar(client, {
        empresaId: base.empresaId, usuarioId: base.atorId, acao: ACAO_GHE_CRIADO, referencia: String(criado.id), ip: base.ip, dispositivo: base.dispositivo,
        contexto: { criadoPor: base.atorId, ...base.contexto }, dadosNovos: instantaneo(criado),
      });
      idsCriados.set(ghe.codigo, criado.id);
      resultadoDoGhe.set(ghe.codigo, 'CRIADO');
      contadores.ghesCriados += 1;
    } else if (ghe.operacao === 'ATRIBUIR_CODIGO') {
      const anterior = ghesTravados.get(ghe.gheId);
      const atualizado = await gheRepo.atualizar(client, base.empresaId, ghe.gheId, { codigo: ghe.codigo });
      await auditoriaRepo.registrar(client, {
        empresaId: base.empresaId, usuarioId: base.atorId, acao: ACAO_GHE_ALTERADO, referencia: String(ghe.gheId), ip: base.ip, dispositivo: base.dispositivo,
        contexto: base.contexto, dadosAnteriores: instantaneo(anterior), dadosNovos: instantaneo(atualizado),
      });
      resultadoDoGhe.set(ghe.codigo, 'CODIGO_ATRIBUIDO');
      contadores.ghesComCodigoAtribuido += 1;
    }
  }

  const linhas = [];
  for (const linha of analise.linhas) {
    let resultado;
    if (linha.aplicavel) {
      const gheId = linha.gheId ?? idsCriados.get(linha.ghe);
      const feito = await aplicarVinculo(client, base, { gheId, tipoId: linha.tipoMaterialId, classificacao: linha.classificacao });
      if (feito === 'CRIADO') contadores.vinculosCriados += 1;
      if (feito === 'ALTERADO') contadores.classificacoesAlteradas += 1;
      resultado = feito === 'SEM_ALTERACAO' ? 'SEM_ALTERACAO' : 'APLICADA';
    } else if (linha.situacao === 'VINCULO_EXISTENTE' || linha.situacao === 'DUPLICADA_NO_ARQUIVO') {
      resultado = 'SEM_ALTERACAO';
    } else {
      resultado = 'BLOQUEADA';
    }
    linhas.push({ ...linha, gheId: linha.gheId ?? idsCriados.get(linha.ghe) ?? null, resultado });
  }

  const ghes = analise.ghes.map((ghe) => ({
    ...ghe,
    gheId: ghe.gheId ?? idsCriados.get(ghe.codigo) ?? null,
    resultado: resultadoDoGhe.get(ghe.codigo) ?? (ghe.situacao === 'GHE_EXISTENTE' ? 'SEM_ALTERACAO' : 'BLOQUEADO'),
  }));
  return { contadores, linhas, ghes };
}

function resumoDoResultado(analise, contadores, linhas) {
  return {
    ...analise.resumo,
    aplicadas: contadores.vinculosCriados + contadores.classificacoesAlteradas,
    ghesCriados: contadores.ghesCriados,
    ghesComCodigoAtribuido: contadores.ghesComCodigoAtribuido,
    vinculosCriados: contadores.vinculosCriados,
    classificacoesAlteradas: contadores.classificacoesAlteradas,
    semAlteracao: linhas.filter((l) => l.resultado === 'SEM_ALTERACAO').length,
    bloqueadas: linhas.filter((l) => l.resultado === 'BLOQUEADA').length,
  };
}

async function confirmar(pool, {
  empresaId, atorId, linhas, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  if (!Array.isArray(linhas)) {
    throw new TypeError('linhas deve ser uma lista');
  }

  return emTransacao(pool, async (client) => {
    await importacaoRepo.travarImportacaoDaEmpresa(client, empresaId);
    const fotografia = await lerFotografia(client, empresaId);
    let analise = analisarLote({ linhas, ...fotografia });
    let ghesTravados = new Map();

    if (temOperacoes(analise)) {
      const idsGhe = [...new Set([
        ...analise.linhas.filter((l) => l.aplicavel && l.gheId !== null).map((l) => l.gheId),
        ...analise.ghes.filter((g) => g.operacao === 'ATRIBUIR_CODIGO').map((g) => g.gheId),
      ])].sort((a, b) => a - b);
      const idsTipo = [...new Set(analise.linhas.filter((l) => l.aplicavel).map((l) => l.tipoMaterialId))].sort((a, b) => a - b);
      const ghesDoBanco = idsGhe.length > 0 ? await importacaoRepo.travarGhes(client, empresaId, idsGhe) : [];
      const tiposDoBanco = idsTipo.length > 0 ? await importacaoRepo.travarTipos(client, empresaId, idsTipo) : [];
      ghesTravados = new Map(ghesDoBanco.map((g) => [g.id, g]));
      analise = analisarLote({
        linhas,
        ghes: mesclar(fotografia.ghes, ghesDoBanco, idsGhe),
        tipos: mesclar(fotografia.tipos, tiposDoBanco, idsTipo),
        vinculos: fotografia.vinculos,
      });
    }

    const importacaoId = crypto.randomUUID();
    const base = { empresaId, atorId, ip, dispositivo, contexto: { origem: ORIGEM, importacaoId } };
    const { contadores, linhas: linhasFinais, ghes } = await executar(client, base, analise, ghesTravados);
    const resumo = resumoDoResultado(analise, contadores, linhasFinais);

    const alteracoes = contadores.ghesCriados + contadores.ghesComCodigoAtribuido + contadores.vinculosCriados + contadores.classificacoesAlteradas;
    if (alteracoes === 0) {
      return { importacaoId: null, resumo, ghes, linhas: linhasFinais };
    }
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO_LOTE, referencia: importacaoId, ip, dispositivo,
      contexto: {
        linhasRecebidas: resumo.linhasRecebidas,
        linhasIgnoradas: resumo.linhasIgnoradas,
        aplicadas: resumo.aplicadas,
        ghesCriados: resumo.ghesCriados,
        ghesComCodigoAtribuido: resumo.ghesComCodigoAtribuido,
        vinculosCriados: resumo.vinculosCriados,
        classificacoesAlteradas: resumo.classificacoesAlteradas,
        semAlteracao: resumo.semAlteracao,
        bloqueadas: resumo.bloqueadas,
        porSituacao: resumo.porSituacao,
      },
    });
    return { importacaoId, resumo, ghes, linhas: linhasFinais };
  });
}

module.exports = { previa, confirmar };
