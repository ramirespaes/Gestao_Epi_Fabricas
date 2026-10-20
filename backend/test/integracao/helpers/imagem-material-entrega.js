'use strict';

const express = require('express');
const servico = require('../../../src/services/imagem-material.service');
const { sha256Hex, webpFicticio, pngFicticio } = require('../../helpers/imagens-ficticias');
const { chaveDe } = require('../../../src/storage/armazenamento-imagens');
const { criarCors, METODOS_PORTAL } = require('../../../src/middleware/cors');
const { criarCabecalhosSeguranca, semCache } = require('../../../src/middleware/cabecalhos');
const { criarVerificacaoOrigem } = require('../../../src/middleware/origem');
const { exigirJson, parserJson } = require('../../../src/middleware/conteudo');
const { notFoundHandler, errorHandler } = require('../../../src/middleware/errorHandler');
const { descritor } = require('./imagem-material');

/**
 * Biblioteca de Imagens, Unidade 5A-1 (RED) — apoio dos testes da ENTREGA de arquivos (GET /api/imagens-material/:origem/:id/:variante).
 *
 * Nada aqui envia imagem por upload nem processa imagem: as linhas entram pelo SERVIÇO da Unidade 3 (`registrarEmpresa`, descritor com os
 * hashes REAIS dos bytes de teste) ou por INSERT direto (biblioteca padrão), e os arquivos são gravados pelo armazenamento da Unidade 1 em
 * um diretório temporário exclusivo. Os bytes são FICTÍCIOS (contêiner RIFF/WEBP bem formado, sem imagem decodificável): a entrega não
 * decodifica nada, só confere SHA-256, tamanho e assinatura. Nenhuma das 30 imagens reais é usada.
 */

let contador = 0;

/**
 * Imagem privada de uma empresa: registra a linha pelo serviço (descritor coerente com os bytes) e grava as variantes pedidas no
 * armazenamento. `bytes` e `hashes` voltam para o teste comparar o que a entrega devolve.
 */
async function semearEmpresa(a, {
  empresaId, atorId, nome, semente, miniatura, exibicao, mestre, gravar = ['mestre', 'exibicao', 'miniatura'], armazenamento = a.armazenamento, inativar = false, versao = null,
}) {
  contador += 1;
  const s = semente ?? `${empresaId}-${contador}`;
  const bytes = {
    mestre: mestre ?? pngFicticio(`m-${s}`),
    exibicao: exibicao ?? webpFicticio(`e-${s}`, 96),
    miniatura: miniatura ?? webpFicticio(`t-${s}`, 48),
  };
  const hashes = { mestre: sha256Hex(bytes.mestre), exibicao: sha256Hex(bytes.exibicao), miniatura: sha256Hex(bytes.miniatura) };
  const sha256 = hashes.mestre;
  const { imagem } = await servico.registrarEmpresa(a.pool, {
    empresaId,
    atorId,
    nome: nome ?? `Imagem de teste ${s}`,
    imagem: descritor({
      sha256, sha256Mestre: hashes.mestre, sha256Exibicao: hashes.exibicao, sha256Miniatura: hashes.miniatura, formato: 'PNG',
      bytesMestre: bytes.mestre.length, bytesExibicao: bytes.exibicao.length, bytesMiniatura: bytes.miniatura.length,
    }),
  });
  const chaves = {
    mestre: chaveDe({ escopo: 'EMPRESA', empresaId, sha256, variante: 'mestre', formato: 'PNG' }),
    exibicao: chaveDe({ escopo: 'EMPRESA', empresaId, sha256, variante: 'exibicao', formato: 'WEBP' }),
    miniatura: chaveDe({ escopo: 'EMPRESA', empresaId, sha256, variante: 'miniatura', formato: 'WEBP' }),
  };
  for (const variante of gravar) await armazenamento.gravar(chaves[variante], bytes[variante], { maxBytes: 8 * 1024 * 1024, sha256Esperado: hashes[variante] });
  if (versao !== null) await a.pool.query('UPDATE imagens_empresa SET versao = $2 WHERE id = $1', [imagem.id, versao]);
  if (inativar) await servico.inativar(a.pool, { empresaId, atorId, imagemId: imagem.id });
  return {
    id: imagem.id, empresaId, nome: imagem.nome, versao: versao ?? imagem.versao, sha256, hashes, bytes, chaves,
  };
}

/** Imagem da biblioteca PADRÃO (global): linha inserida direto, no schema temporário; a exibição é opcional (hoje ela não existe no pacote). */
async function semearPadrao(a, {
  nome, semente, miniatura, exibicao = null, ativo = true, armazenamento = a.armazenamento,
}) {
  contador += 1;
  const s = semente ?? `padrao-${contador}`;
  const mestre = pngFicticio(`pm-${s}`);
  const bytes = { mestre, miniatura: miniatura ?? webpFicticio(`pt-${s}`, 40), exibicao };
  const hashes = { mestre: sha256Hex(mestre), miniatura: sha256Hex(bytes.miniatura), exibicao: exibicao === null ? null : sha256Hex(exibicao) };
  const sha256 = hashes.mestre;
  const linha = await a.padrao({
    nome: nome ?? `Padrão de teste ${s}`,
    sha256,
    sha256_miniatura: hashes.miniatura,
    bytes_mestre: mestre.length,
    bytes_miniatura: bytes.miniatura.length,
    ativo,
    ...(exibicao === null ? {} : { sha256_exibicao: hashes.exibicao, bytes_exibicao: exibicao.length }),
  });
  const chaves = {
    mestre: chaveDe({ escopo: 'PADRAO', sha256, variante: 'mestre', formato: 'PNG' }),
    miniatura: chaveDe({ escopo: 'PADRAO', sha256, variante: 'miniatura', formato: 'WEBP' }),
    exibicao: chaveDe({ escopo: 'PADRAO', sha256, variante: 'exibicao', formato: 'WEBP' }),
  };
  await armazenamento.gravar(chaves.mestre, mestre, { maxBytes: 8 * 1024 * 1024, sha256Esperado: hashes.mestre });
  await armazenamento.gravar(chaves.miniatura, bytes.miniatura, { maxBytes: 8 * 1024 * 1024, sha256Esperado: hashes.miniatura });
  if (exibicao !== null) await armazenamento.gravar(chaves.exibicao, exibicao, { maxBytes: 8 * 1024 * 1024, sha256Esperado: hashes.exibicao });
  return {
    id: String(linha.id), sha256, hashes, bytes, chaves, versao: linha.versao ?? 1,
  };
}

/** Envolve um armazenamento para registrar TODA chave pedida (abrir e existe). O que não é método de leitura passa direto. */
function instrumentar(base) {
  const chamadas = [];
  const envolver = (metodo) => async (...argumentos) => {
    chamadas.push({ metodo, chave: typeof argumentos[0] === 'string' ? argumentos[0] : null });
    return base[metodo](...argumentos);
  };
  return {
    chamadas,
    gravar: base.gravar,
    abrir: envolver('abrir'),
    existe: envolver('existe'),
    remover: base.remover,
    removerVariantes: base.removerVariantes,
    listar: base.listar,
    chaveDe: base.chaveDe,
  };
}

/** Cabeçalhos que têm de ser IDÊNTICOS entre dois 404 (tudo, menos o que muda a cada resposta). */
function cabecalhosComparaveis(resposta) {
  const ignorados = new Set(['date', 'connection', 'keep-alive']);
  return Object.fromEntries(Object.entries(resposta.headers).filter(([nome]) => !ignorados.has(nome)).sort(([x], [y]) => x.localeCompare(y)));
}

/** Silencia e captura console.error durante o teste (o registro técnico padrão do projeto). Devolve tudo o que foi registrado, em texto. */
function capturarErros(t) {
  const espiao = t.mock.method(console, 'error', () => {});
  return {
    chamadas: () => espiao.mock.calls.map((c) => c.arguments),
    texto: () => espiao.mock.calls.map((c) => c.arguments.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ')).join('\n'),
  };
}

/** Tokens do cabeçalho Vary (minúsculos, sem duplicata). */
const tokensDeVary = (resposta) => [...new Set(String(resposta.headers.vary ?? '').split(',').map((x) => x.trim().toLowerCase()).filter(Boolean))].sort();

/** Executa `fn` com variáveis de ambiente alteradas (undefined = ausente) e restaura SEMPRE, mesmo se `fn` falhar. */
async function comAmbiente(alteracoes, fn) {
  const anteriores = Object.fromEntries(Object.keys(alteracoes).map((nome) => [nome, process.env[nome]]));
  const aplicar = (valores) => {
    for (const [nome, valor] of Object.entries(valores)) {
      if (valor === undefined) delete process.env[nome]; else process.env[nome] = valor;
    }
  };
  try {
    aplicar(alteracoes);
    return await fn();
  } finally {
    aplicar(anteriores);
  }
}

/**
 * Cadeia de produção em miniatura: os MESMOS componentes de app.js (cabeçalhos de segurança do Helmet, CORS da API, sem cache, verificação
 * de origem, política de conteúdo, tratamento de 404 e de erro), com a allowlist de teste e sem HSTS. O limite de taxa NÃO entra aqui: o de
 * app.js é provado no app real (app-imagem-material-limite.test.js).
 */
function comporCadeiaDeProducao(rotas, { origens, hstsAtivo = false } = {}) {
  const app = express();
  app.disable('x-powered-by');
  app.use(criarCabecalhosSeguranca({ hstsAtivo }));
  app.use('/api', criarCors({ origens, metodos: METODOS_PORTAL }), semCache, criarVerificacaoOrigem({ origens }), exigirJson, parserJson, ...rotas);
  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}

module.exports = {
  sha256Hex, webpFicticio, pngFicticio, semearEmpresa, semearPadrao, instrumentar, cabecalhosComparaveis, capturarErros, tokensDeVary, comAmbiente, comporCadeiaDeProducao,
};
