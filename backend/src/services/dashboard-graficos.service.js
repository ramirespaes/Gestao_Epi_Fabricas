'use strict';

const autorizacao = require('../middleware/autorizacao');
const repo = require('../repositories/dashboard-graficos.repository');
const entregasRepo = require('../repositories/relatorio-entregas.repository');
const { filtrosDeEntregas } = require('./relatorio.service');
const { exigirDataOperacional } = require('../utils/data-operacional');

/**
 * Gráficos do Dashboard (12I) — somente leitura.
 *
 * A rota já exigiu `dashboard.visualizar`. Cada gráfico só sai se o usuário vê a FONTE, pela mesma função que autoriza as rotas:
 *   setores       -> employeeHistory.visualizar (os funcionários);
 *   episEntregues -> epiFicha.visualizar (a permissão da aba "EPIs entregues" e do cartão do mesmo nome).
 * Sem a permissão: { permitido: false }. Empresa, usuário e perfil vêm só da sessão.
 *
 * Os períodos são de CALENDÁRIO pela data operacional (São Paulo): MES = o mês corrente, por dia (de 1º até hoje); SEIS_MESES e ANO = os
 * seis/doze meses terminando no corrente, por mês. As chaves dos grupos saem daqui para o gráfico mostrar zero onde não há dado.
 *
 * Produtos: os cinco de maior total no período (pela mesma população do relatório "EPIs entregues"), fixos para a série inteira; `total`
 * é a soma de TODAS as unidades do período (a mesma soma do cartão "EPIs entregues" quando o período é o mês), não só das cinco.
 */

const PERIODOS = Object.freeze(['MES', 'SEIS_MESES', 'ANO']);
const MESES_POR_PERIODO = Object.freeze({ SEIS_MESES: 6, ANO: 12 });
const LIMITE_PRODUTOS = 5;
const FONTES = Object.freeze({ setores: 'employeeHistory', entregas: 'epiFicha' });
const NEGADO = Object.freeze({ permitido: false });

const dois = (n) => String(n).padStart(2, '0');
const mesTxt = (ano, mes) => `${String(ano).padStart(4, '0')}-${dois(mes)}`;
const ultimoDia = (ano, mes) => new Date(Date.UTC(ano, mes, 0)).getUTCDate();

function periodoDoGrafico(hoje, periodo) {
  exigirDataOperacional(hoje);
  if (!PERIODOS.includes(periodo)) throw new TypeError('período do gráfico inválido');
  const [ano, mes, dia] = hoje.split('-').map(Number);
  const ate = `${mesTxt(ano, mes)}-${dois(ultimoDia(ano, mes))}`;
  if (periodo === 'MES') {
    const chaves = [];
    for (let d = 1; d <= dia; d += 1) chaves.push(`${mesTxt(ano, mes)}-${dois(d)}`);
    return { periodo, de: `${mesTxt(ano, mes)}-01`, ate, agrupamento: 'DIA', chaves };
  }
  const chaves = [];
  for (let n = MESES_POR_PERIODO[periodo] - 1; n >= 0; n -= 1) {
    const d = new Date(Date.UTC(ano, mes - 1 - n, 1));
    chaves.push(mesTxt(d.getUTCFullYear(), d.getUTCMonth() + 1));
  }
  return { periodo, de: `${chaves[0]}-01`, ate, agrupamento: 'MES', chaves };
}

function exigirContexto({ empresaId, usuarioId, perfil, hoje, periodo }) {
  if (!Number.isInteger(empresaId) || empresaId <= 0) throw new TypeError('identificador de empresa inválido');
  if (!Number.isInteger(usuarioId) || usuarioId <= 0) throw new TypeError('identificador de usuário inválido');
  if (typeof perfil !== 'string' || perfil.length === 0) throw new TypeError('perfil inválido');
  const janela = periodoDoGrafico(hoje, periodo);
  return { contexto: { empresaId, usuarioId, perfil }, janela };
}

async function podeVer(pool, contexto, recurso) {
  const decisao = await autorizacao.avaliarPermissaoRecurso(pool, contexto, recurso);
  return decisao.visualizar === true;
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

async function setores(pool, entrada) {
  const { contexto, janela } = exigirContexto(entrada);
  if (!(await podeVer(pool, contexto, FONTES.setores))) return { ...NEGADO };
  const linhas = await repo.contarAtivosPorSetor(pool, contexto.empresaId, { de: janela.de, ate: janela.ate });
  return {
    permitido: true,
    periodo: janela.periodo,
    de: janela.de,
    ate: janela.ate,
    total: linhas.reduce((s, l) => s + l.quantidade, 0),
    setores: linhas.map((l) => ({ setor: l.setor === null ? 'Sem setor' : l.setor, quantidade: l.quantidade })),
  };
}

async function episEntregues(pool, entrada) {
  const { contexto, janela } = exigirContexto(entrada);
  if (!(await podeVer(pool, contexto, FONTES.entregas))) return { ...NEGADO };
  const filtros = filtrosDeEntregas({ de: janela.de, ate: janela.ate }, { min: null, max: null });
  const { empresaId } = contexto;
  // As três leituras saem do mesmo instantâneo, para o total, o top e a série fecharem entre si.
  const { produtos, serie, total } = await emLeitura(pool, async (client) => {
    const top = await repo.topProdutosEntregues(client, empresaId, filtros, { limite: LIMITE_PRODUTOS });
    const [linhas, soma] = await Promise.all([
      top.length > 0 ? repo.seriePorProduto(client, empresaId, filtros, { materialIds: top.map((p) => p.materialId), agrupamento: janela.agrupamento }) : [],
      entregasRepo.somarQuantidade(client, empresaId, filtros),
    ]);
    return { produtos: top, serie: linhas, total: soma };
  });
  const coluna = new Map(produtos.map((p, c) => [p.materialId, c]));
  const porChave = new Map(janela.chaves.map((chave) => [chave, produtos.map(() => 0)]));
  for (const l of serie) {
    const quantidades = porChave.get(l.chave);
    const c = coluna.get(l.materialId);
    if (quantidades && c !== undefined) quantidades[c] += l.quantidade;
  }
  return {
    permitido: true,
    periodo: janela.periodo,
    de: janela.de,
    ate: janela.ate,
    agrupamento: janela.agrupamento,
    total,
    produtos,
    series: janela.chaves.map((chave) => ({ chave, quantidades: porChave.get(chave) })),
  };
}

module.exports = { setores, episEntregues, periodoDoGrafico, PERIODOS, LIMITE_PRODUTOS, FONTES };
