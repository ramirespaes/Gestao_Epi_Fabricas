'use strict';

const crypto = require('node:crypto');
const request = require('supertest');
const { abrirAmbienteAtendimento, BASE, cookieDoAtendimentoNaResposta, cabecalhoCookie, modulosD } = require('./token-atendimento');
const { inserir, criarMaterial, criarLote } = require('./entrega-epi');
const base = require('./token-tablet');
const { ORIGEM } = base;
const { sessaoDeTeste } = require('./ambiente-http-12d2');
const { criarAppTeste } = require('../../helpers/app-teste');
const { criarVerificacaoOrigem } = require('../../../src/middleware/origem');
const { criarExigirSessao } = require('../../../src/middleware/autenticacao');
const { criarLimitador } = require('../../../src/middleware/rate-limit');

/**
 * Atendimento Token — Etapa E (RED): ambiente do CATÁLOGO de materiais do atendimento. Reutiliza o ambiente da Etapa D (tablet
 * autenticado, atendimento temporário) e acrescenta construtores de dados sobre as estruturas REAIS do sistema:
 *   funcionarios.grupo_homogeneo_id (006) · grupos_homogeneos_exposicao (004, ativo) · ghe_materiais (041) · tipos_material (082)
 *   · ghe_tipos_material (083) · materiais (007/039/044/082, ativo, exige_tamanho, tipo_material_id) · material_tamanhos (070, grade)
 *   · estoque_lotes (042, só para provar que o saldo não interfere).
 * Nenhuma tabela ou coluna fictícia.
 *
 * Contrato proposto (GREEN E ainda NÃO implementado): GET /api/atendimento-token/tablet/atendimento/catalogo
 *   200 { status: 'ok', catalogo: { estado: 'OK' | 'SEM_GHE' | 'GHE_INATIVO' | 'SEM_MATERIAIS', total, materiais: [{
 *           id, nome, unidade, categoria, grupoProtecao, tipo: { id, nome } | null, exigeTamanho, tamanhos: [string],
 *           imagem: { disponivel: false } | { disponivel: true, versao, caminho } }] } }
 */

const CATALOGO = `${BASE}/catalogo`;
const CHAVES_DO_MATERIAL = Object.freeze(['categoria', 'exigeTamanho', 'grupoProtecao', 'id', 'imagem', 'nome', 'tamanhos', 'tipo', 'unidade']);

async function abrirAmbienteCatalogo() {
  const a = await abrirAmbienteAtendimento();
  let seq = 0;
  const unico = (prefixo) => { seq += 1; return `${prefixo} E${seq}`; };

  const ghe = async (empresaId, { ativo = true, nome } = {}) => (await inserir(a.ctx.pool, 'grupos_homogeneos_exposicao', { empresa_id: empresaId, nome: nome ?? unico('GHE'), ativo })).id;

  /** Tipo do catálogo da empresa (tipos_material). Devolve a linha inteira. */
  const tipo = async (empresaId, { nome, ativo = true, grupo = 'EPI', protecao = 'Proteção auditiva' } = {}) => inserir(a.ctx.pool, 'tipos_material', {
    empresa_id: empresaId, grupo, grupo_protecao: protecao, nome: nome ?? unico('Tipo'), ativo, origem: 'MANUAL',
  });

  /**
   * Material físico. `tipoLinha` (de `tipo()`) o torna V2 e vinculado ao tipo do catálogo; sem ele é um material legado (texto livre
   * em `tipo`, sem tipo_material_id). `grade` = tamanhos da grade (exige exigeTamanho); `lotes` = [{ tamanho, quantidade }].
   */
  async function material(empresaId, {
    nome, ativo = true, exigeTamanho = false, tipoLinha = null, tipoTexto = null, grade = [], lotes = [], unidade = 'unidade',
  } = {}) {
    const n = nome ?? unico('Material');
    let id;
    if (tipoLinha !== null) {
      id = (await inserir(a.ctx.pool, 'materiais', {
        empresa_id: empresaId, nome: n, exige_ca: true, exige_tamanho: exigeTamanho, prazo_uso_dias: 180, unidade, ativo,
        modelo_classificacao: 'V2', categoria: tipoLinha.grupo, grupo_protecao: tipoLinha.grupo_protecao, tipo: tipoLinha.nome, tipo_material_id: tipoLinha.id,
      })).id;
    } else {
      id = await criarMaterial(a.ctx.pool, empresaId, n, { exigeTamanho, tipo: tipoTexto, unidade, ativo });
    }
    for (const [i, tamanho] of grade.entries()) {
      await inserir(a.ctx.pool, 'material_tamanhos', { empresa_id: empresaId, material_id: id, tamanho, ordem: i + 1 });
    }
    // `quantidade` = saldo final do lote. Zero é um lote que teve entrada e foi TOTALMENTE baixado por uma operação BAIXA real (a entrada
    // não pode ser zero: chk_estoque_lotes_quantidade_entrada).
    for (const lote of lotes) {
      const entrada = Math.max(lote.quantidade, 1);
      const loteId = await criarLote(a.ctx.pool, { empresaId, materialId: id, quantidade: entrada, tamanho: lote.tamanho ?? '40' });
      if (lote.quantidade === 0) {
        seq += 1;
        await inserir(a.ctx.pool, 'estoque_operacoes', {
          empresa_id: empresaId, lote_id: loteId, tipo: 'BAIXA', quantidade: entrada, motivo: 'AVARIA', usuario_id: a.masterDe(empresaId),
          chave_idempotencia: crypto.randomUUID(), requisicao_hash: String(seq).padStart(64, '0'),
        });
      }
    }
    return id;
  }

  const vincularMaterial = (empresaId, gheId, materialId) => inserir(a.ctx.pool, 'ghe_materiais', { empresa_id: empresaId, grupo_homogeneo_id: gheId, material_id: materialId });
  const vincularTipo = (empresaId, gheId, tipoId, classificacao = 'OBRIGATORIO') => inserir(a.ctx.pool, 'ghe_tipos_material', {
    empresa_id: empresaId, grupo_homogeneo_id: gheId, tipo_material_id: tipoId, classificacao,
  });

  /** Funcionário da empresa com o GHE (ou sem) e a situação pedidos. */
  async function funcionarioNoGhe(empresaId, gheId, opcoes = {}) {
    const f = await a.funcionario(empresaId, opcoes);
    if (gheId !== null) await a.q('UPDATE funcionarios SET grupo_homogeneo_id = $2 WHERE id = $1', [f.id, gheId]);
    return { ...f, grupo_homogeneo_id: gheId };
  }

  const tabletNovo = (empresaId = a.d.empresaA, horas = 0) => a.ativado(empresaId, { horasDesdeEmissao: horas });

  /** Tablet + funcionário no GHE + atendimento aberto REAL pela API (CPF por padrão). Devolve tudo o que o cenário precisa. */
  async function cenario(app, { empresaId = a.d.empresaA, gheId = null, funcionario = {}, tipoIdentificador = 'CPF', tablet = null } = {}) {
    const f = await funcionarioNoGhe(empresaId, gheId, funcionario);
    const t = tablet ?? await tabletNovo(empresaId);
    const corpo = tipoIdentificador === 'CPF' ? { tipo: 'CPF', valor: f.cpf } : { tipo: 'MATRICULA', valor: f.matricula };
    const r = await a.identificar(app, t.credencial, corpo);
    if (r.status !== 201) throw new Error(`premissa: o atendimento deveria abrir (${r.status} ${JSON.stringify(r.body)})`);
    const token = cookieDoAtendimentoNaResposta(r).valor;
    const [linha] = await a.abertosDe(t.id);
    return { f, t, token, gheId, atendimentoId: linha.id };
  }

  /**
   * App de teste = o da Etapa D (rotas C, D e administrativas B/C) + a rota REAL do catálogo (Etapa E). A composição da D vive em
   * helper congelado; aqui é repetida só o suficiente para acrescentar o router do catálogo. Mesmas opções do `criarApp` da D.
   */
  function criarApp({ hops = 0, admin = 'cabecalho', limitador = criarLimitador({ limite: 100000, janelaSegundos: 60 }), limitadorIdentificacao, limitadorDispositivo, origens = [base.ORIGEM] } = {}) {
    const c = base.modulos();
    const d = modulosD();
    const catalogoRotas = require('../../../src/routes/token-catalogo.routes');
    const catalogoController = require('../../../src/controllers/token-catalogo.controller');
    const exigirSessao = admin === 'cookie' ? criarExigirSessao({ pool: a.ctx.pool }) : sessaoDeTeste(a.ctx.pool);
    return criarAppTeste((ap) => {
      ap.set('trust proxy', hops === 0 ? false : hops);
      ap.use('/api', criarVerificacaoOrigem({ origens }));
      ap.use('/api', c.tabletRotas.criarTokenTabletRoutes({ controller: c.tabletController.criarTokenTabletController({ pool: a.ctx.pool }), limitador: limitador ?? undefined, limitadorDispositivo, pool: a.ctx.pool }));
      ap.use('/api', d.rotas.criarTokenAtendimentoRoutes({
        controller: d.controller.criarTokenAtendimentoController({ pool: a.ctx.pool }), pool: a.ctx.pool, limitador: limitador ?? undefined, limitadorIdentificacao, limitadorDispositivo,
      }));
      ap.use('/api', catalogoRotas.criarTokenCatalogoRoutes({
        controller: catalogoController.criarTokenCatalogoController({ pool: a.ctx.pool }), pool: a.ctx.pool, limitador: limitador ?? undefined, limitadorDispositivo,
      }));
      if (admin !== null) {
        ap.use('/api', c.ativacaoRotas.criarTokenAtivacaoRoutes({ controller: c.ativacaoController.criarTokenAtivacaoController({ pool: a.ctx.pool }), exigirSessao, pool: a.ctx.pool }));
        ap.use('/api', c.dispositivoRotas.criarTokenDispositivoRoutes({ controller: c.dispositivoController.criarTokenDispositivoController({ pool: a.ctx.pool }), exigirSessao, pool: a.ctx.pool }));
      }
    });
  }

  const catalogo = (app, t, token, cabecalhos = {}) => a.pedir(app, 'GET', CATALOGO, t, token, cabecalhos);

  /** GET cru (query livre) com os dois cookies, para provar que parâmetros do navegador não ampliam nada. */
  const catalogoComQuery = (app, t, token, query) => request(app).get(`${CATALOGO}?${query}`).set('Cookie', cabecalhoCookie(t.credencial, token));

  /** POST/PUT/PATCH/DELETE no mesmo caminho: o catálogo é só leitura. */
  const escreverNoCatalogo = (app, metodo, t, token) => request(app)[metodo](CATALOGO).set('Origin', ORIGEM).set('Cookie', cabecalhoCookie(t.credencial, token)).send({});

  return {
    ...a, criarApp, ghe, tipo, material, vincularMaterial, vincularTipo, funcionarioNoGhe, tabletNovo, cenario, catalogo, catalogoComQuery, escreverNoCatalogo,
  };
}

module.exports = { CATALOGO, CHAVES_DO_MATERIAL, abrirAmbienteCatalogo };
