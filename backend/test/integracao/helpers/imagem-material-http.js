'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const request = require('supertest');
const { montarAmbiente, CABECALHO, sessaoDeTeste } = require('./ambiente-http-12d2');
const { inserir } = require('./entrega-epi');
const { descritor } = require('./imagem-material');
const { criarAppTeste } = require('../../helpers/app-teste');
const { criarMaterialController } = require('../../../src/controllers/material.controller');
const { criarMaterialRoutes } = require('../../../src/routes/material.routes');
const { criarExigirSessao } = require('../../../src/middleware/autenticacao');
const { criarVerificacaoOrigem } = require('../../../src/middleware/origem');
const servico = require('../../../src/services/imagem-material.service');
const { criarArmazenamentoImagens } = require('../../../src/storage/armazenamento-imagens');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../../storage/helpers/tmp-seguro');
const { comporCadeiaDeProducao } = require('./imagem-material-entrega');

/**
 * Unidade 5A-1 (RED da entrega de arquivos), acréscimo ADITIVO: `montarAmbienteHttpImagens({ comArmazenamento: true })` cria um diretório
 * temporário exclusivo e um armazenamento real (Unidade 1) e o entrega ao controller; `appDeEntrega(...)` e `cadeiaDeProducao(...)` montam
 * apps com um armazenamento/CORP específico (instrumentado, nulo = indisponível). Sem a opção, nada muda para as suítes da Unidade 4.
 * Unidade 5C-1 (RED do envio), acréscimo ADITIVO: `montarAmbienteHttpImagens({ comArmazenamento: true, processador })` entrega ao controller a PORTA de
 * processamento de imagem (`processar(bytes) -> { formato, largura, altura, mestre, exibicao, miniatura }`; nos testes, o falso de test/helpers/processador-imagem-falso.js,
 * nunca uma biblioteca de imagem). O controller compõe o serviço de envio com `armazenamento` e `processador` (nomes previstos, a confirmar no GREEN da 5C-2). Sem a opção,
 * o controller não recebe `processador` e tudo se comporta como antes.
 * Contrato previsto da fábrica do controller (a confirmar no GREEN da 5A-1):
 *   criarImagemMaterialController({ pool, armazenamento, entrega, corp }) — `armazenamento` é uma instância ou `null` (indisponível, 503);
 *   `entrega` (opcional) substitui o serviço de entrega; `corp` é 'same-origin' (padrão) ou 'same-site'; sem nenhum deles, vale o ambiente.
 *
 * Biblioteca de Imagens, Unidade 4 (RED) — ambiente HTTP das rotas da biblioteca e do campo `imagem` dos materiais, sobre o ambiente HTTP
 * real da 12D-2 (PostgreSQL real, schema temporário exclusivo com TODAS as migrations, mundo de duas empresas provisionadas, sessão de teste
 * por cabeçalho `x-teste-usuario` que lê empresa e perfil do banco). As rotas de MATERIAIS são as de produção. As rotas da BIBLIOTECA
 * (`src/routes/imagem-material.routes.js` + `src/controllers/imagem-material.controller.js`) ainda NÃO existem: quando existirem, são
 * montadas na mesma cadeia; enquanto não existem, qualquer chamada a elas responde 404 ROTA_NAO_ENCONTRADA, e cada teste falha por isso,
 * explicitamente. Nenhuma imagem é enviada por upload aqui (processamento é de outra unidade): as imagens privadas entram pelo SERVIÇO da
 * Unidade 3 (`registrarEmpresa` com descritor sintético) e as padrão por INSERT direto, só no schema temporário.
 *
 * Contrato previsto para a fábrica (mesmo molde de material.routes.js):
 *   criarImagemMaterialRoutes({ controller, exigirSessao, pool }) e criarImagemMaterialController({ pool }).
 */

const ORIGEM_PERMITIDA = 'https://portal.teste.invalid';

function carregarRotasDeImagem() {
  try {
    // eslint-disable-next-line global-require
    const rotas = require('../../../src/routes/imagem-material.routes');
    // eslint-disable-next-line global-require
    const controller = require('../../../src/controllers/imagem-material.controller');
    return { criarRotas: rotas.criarImagemMaterialRoutes, criarController: controller.criarImagemMaterialController };
  } catch (erro) {
    if (erro && erro.code === 'MODULE_NOT_FOUND' && /imagem-material\.(routes|controller)/.test(String(erro.message))) return null;
    throw erro;
  }
}

async function montarAmbienteHttpImagens({ comArmazenamento = false, processador } = {}) {
  const amb = await montarAmbiente();
  const { pool } = amb;
  const rotasDeImagem = carregarRotasDeImagem();
  let sequencia = 0;
  const proximo = () => { sequencia += 1; return sequencia; };

  let raizDeImagens = null;
  let armazenamento = null;
  if (comArmazenamento) {
    try {
      raizDeImagens = criarRaizTemporaria();
      armazenamento = criarArmazenamentoImagens({ diretorio: raizDeImagens });
    } catch (erro) {
      if (raizDeImagens !== null) removerTemporarioSeguro(raizDeImagens);
      await amb.encerrar();
      throw erro;
    }
  }

  // Dependências do controller: `armazenamento`, `corp` e `processador` só entram quando informados (ausente = comportamento atual, que vale o ambiente).
  const controllerDeImagem = ({ armazenamento: armaz, corp } = {}) => {
    const dependencias = { pool };
    if (armaz !== undefined) dependencias.armazenamento = armaz;
    if (corp !== undefined) dependencias.corp = corp;
    if (processador !== undefined) dependencias.processador = processador;
    return rotasDeImagem.criarController(dependencias);
  };

  function rotasDoApp(exigirSessao, { armazenamento: armaz, corp } = {}) {
    const rotas = [criarMaterialRoutes({ controller: criarMaterialController({ pool }), exigirSessao, pool })];
    if (rotasDeImagem !== null) rotas.push(rotasDeImagem.criarRotas({ controller: controllerDeImagem({ armazenamento: armaz, corp }), exigirSessao, pool }));
    return rotas;
  }

  function montarApp(exigirSessao, { origens = null, armazenamento: armaz, corp } = {}) {
    return criarAppTeste((a) => {
      const cadeia = [];
      if (origens !== null) cadeia.push(criarVerificacaoOrigem({ origens }));
      cadeia.push(...rotasDoApp(exigirSessao, { armazenamento: armaz, corp }));
      a.use('/api', ...cadeia);
    });
  }

  const sessaoTeste = sessaoDeTeste(pool);
  const app = montarApp(sessaoTeste, { armazenamento: comArmazenamento ? armazenamento : undefined });
  const appComSessaoReal = montarApp(criarExigirSessao({ pool }));
  const appComOrigem = montarApp(sessaoTeste, { origens: [ORIGEM_PERMITIDA] });

  /** App com as rotas reais da biblioteca e um armazenamento/CORP específicos (instrumentado; `null` = indisponível). Padrão: o do ambiente. */
  const appDeEntrega = ({ armazenamento: armaz = armazenamento, corp, exigirSessao = sessaoTeste, origens = null } = {}) => montarApp(exigirSessao, { origens, armazenamento: armaz, corp });

  /** App com as rotas reais e NENHUMA dependência de entrega informada: o controller resolve armazenamento e CORP pelo AMBIENTE (process.env), como em produção. */
  const appDoAmbiente = ({ exigirSessao = sessaoTeste } = {}) => montarApp(exigirSessao);

  /** A cadeia de PRODUÇÃO em miniatura (Helmet, CORS, sem cache, origem, conteúdo, 404 e erro) com as mesmas rotas. */
  const cadeiaDeProducao = ({ armazenamento: armaz = armazenamento, corp, exigirSessao = sessaoTeste, origens = [ORIGEM_PERMITIDA] } = {}) => comporCadeiaDeProducao(
    rotasDoApp(exigirSessao, { armazenamento: armaz, corp }),
    { origens },
  );

  const encerrarBase = amb.encerrar;
  const encerrar = async () => {
    try { await encerrarBase(); } finally { if (raizDeImagens !== null) removerTemporarioSeguro(raizDeImagens); }
  };

  /** Quem chama, já identificado pela sessão de teste. `em` troca o app (origem/sessão real). */
  const como = (usuarioId, em = app) => {
    const com = (metodo) => (url) => request(em)[metodo](url).set(CABECALHO, String(usuarioId));
    return {
      get: com('get'), head: com('head'), post: com('post'), patch: com('patch'), put: com('put'), delete: com('delete'),
    };
  };
  const anonimo = (em = appComSessaoReal) => ({
    get: (url) => request(em).get(url), post: (url) => request(em).post(url), patch: (url) => request(em).patch(url), delete: (url) => request(em).delete(url),
  });

  /** Imagem privada registrada pelo SERVIÇO da Unidade 3 (sem upload); devolve a projeção pública (id como texto). */
  const imagemDaEmpresa = async (empresaId, atorId, { nome, ...extra } = {}) => (await servico.registrarEmpresa(pool, {
    empresaId, atorId, nome: nome ?? `Imagem HTTP ${proximo()}`, imagem: descritor(extra),
  })).imagem;

  /** Imagem padrão sintética (global), só neste schema. */
  const padrao = async (extra = {}) => {
    const n = proximo();
    const sha = (s) => require('node:crypto').createHash('sha256').update(`http-${s}-${n}`).digest('hex');
    return inserir(pool, 'imagens_padrao', {
      nome: `Padrão HTTP ${n}`, arquivo_origem: `padrao-http-${n}.png`, sha256: sha('p'), sha256_miniatura: sha('m'), formato: 'PNG',
      largura: 1024, altura: 1024, bytes_mestre: 80000, bytes_miniatura: 8000, ...extra,
    });
  };
  const sugestao = (imagemPadraoId, tipoNome, nivel = 'PRINCIPAL') => inserir(pool, 'imagens_padrao_tipos', {
    imagem_padrao_id: imagemPadraoId, tipo_nome: tipoNome, nivel, aprovado_por: 'V7', aprovado_em: '2026-10-16',
  });

  /** Corpo mínimo e válido de POST /api/materiais hoje (classificação V2 "Outros", sem catálogo). */
  const corpoDeMaterial = (extra = {}) => ({
    nome: `Material HTTP ${proximo()}`, prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade',
    categoria: 'Outros', categoriaDescricao: 'Item de teste', tipo: 'Outros', tipoDescricao: 'Item de teste', ...extra,
  });

  const q = (sql, params) => pool.query(sql, params);
  const linhaDaImagem = async (id) => (await q('SELECT id, empresa_id, nome, estado, versao FROM imagens_empresa WHERE id = $1', [id])).rows[0] ?? null;
  const imagemDoMaterial = async (materialId) => (await q('SELECT imagem_padrao_id, imagem_empresa_id FROM materiais WHERE id = $1', [materialId])).rows[0];
  const contagem = async (tabela, onde = 'true', params = []) => (await q(`SELECT count(*)::int AS n FROM ${tabela} WHERE ${onde}`, params)).rows[0].n;
  const auditorias = async (acao, referencia) => (await q(
    'SELECT empresa_id, usuario_id, acao, referencia, contexto, dados_anteriores, dados_novos FROM logs_auditoria WHERE acao = $1 AND referencia = $2 ORDER BY id',
    [acao, String(referencia)],
  )).rows;

  /** Nada interno pode sair em resposta nenhuma: hashes, bytes, chaves, caminhos, criador, empresa. */
  const semCamposInternos = (corpo, onde = '') => {
    const texto = JSON.stringify(corpo);
    for (const proibido of ['sha256', 'bytesMestre', 'bytesExibicao', 'bytesMiniatura', 'bytes_', 'caminho', 'chave', 'criadoPor', 'criado_por', 'empresaId', 'empresa_id', 'diretorio', 'storage']) {
      assert.equal(texto.includes(proibido), false, `${onde} vazou ${proibido}`);
    }
  };

  return {
    ...amb, app, appComSessaoReal, appComOrigem, rotasDeImagem, ORIGEM_PERMITIDA, CAMINHO_ROTAS: path.join('src', 'routes', 'imagem-material.routes.js'),
    como, anonimo, imagemDaEmpresa, padrao, sugestao, corpoDeMaterial, q, linhaDaImagem, imagemDoMaterial, contagem, auditorias, semCamposInternos,
    armazenamento, raizDeImagens, appDeEntrega, appDoAmbiente, cadeiaDeProducao, encerrar,
  };
}

module.exports = { montarAmbienteHttpImagens, ORIGEM_PERMITIDA };
