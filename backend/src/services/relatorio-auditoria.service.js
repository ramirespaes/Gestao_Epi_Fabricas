'use strict';

const { HttpError } = require('../errors/HttpError');
const repo = require('../repositories/relatorio-auditoria.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const loteRepo = require('../repositories/estoque-lote.repository');
const { padraoParcial } = require('./entrega-epi-consulta.service');
const { DIAS_ALERTA_VALIDADE_CA } = require('../schemas/itens-disponiveis.schema');
const { dataOperacional } = require('../utils/data-operacional');

/**
 * Relatório — Auditoria (12K-D5). Só leitura (a única escrita é a auditoria da própria consulta à trilha). Empresa e ator
 * vêm sempre da sessão. A autoridade (reportsAudit.visualizar) é das rotas.
 *
 * Entregas pendentes: solicitações APROVADA/APROVADA_PARCIAL com quantidade aprovada ainda não entregue.
 * Não existe prazo oficial (SLA): nenhum status "Atrasado".
 */

const DIAS_PADRAO_DO_LOG = 30;
const PERIODO_MAXIMO_DIAS = 92;
const ACAO_CONSULTA = 'AUDITORIA_LOG_CONSULTADA';
const JANELA_AUDITORIA_CONSULTA_S = 300;

// ─── Datas (dia civil de São Paulo, como o resto do sistema) ────────

function somarDias(iso, dias) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}
const diasEntre = (de, ate) => Math.round((Date.parse(`${ate}T00:00:00Z`) - Date.parse(`${de}T00:00:00Z`)) / 86400000);

/** Padrão: os últimos 30 dias. Só `de` vai até hoje; só `ate` olha 30 dias para trás. Máximo de 92 dias, para segurança e desempenho. */
function periodoDoLog({ de, ate }, hoje) {
  const fim = ate ?? hoje;
  const inicio = de ?? somarDias(fim, -(DIAS_PADRAO_DO_LOG - 1));
  if (inicio > fim) throw HttpError.badRequest('PERIODO_INVERTIDO', 'A data final precisa ser igual ou posterior à inicial');
  if (diasEntre(inicio, fim) + 1 > PERIODO_MAXIMO_DIAS) {
    throw HttpError.badRequest('PERIODO_MAXIMO_EXCEDIDO', `O período da trilha não pode passar de ${PERIODO_MAXIMO_DIAS} dias`);
  }
  return { de: inicio, ate: fim };
}

// ─── Origem (navegador e sistema derivados do User-Agent gravado) ───

const NAVEGADORES = [
  ['Edge', /\bEdg(?:e|A|iOS)?\/\d/], ['Opera', /\bOPR\/\d/], ['Firefox', /\bFirefox\/\d/], ['Chrome', /\b(?:Chrome|CriOS)\/\d/], ['Safari', /\bVersion\/[\d.]+.*\bSafari\/\d/],
];
const SISTEMAS = [
  ['Windows', /\bWindows NT\b/], ['Android', /\bAndroid\b/], ['iOS', /\b(?:iPhone|iPad|iPod)\b/], ['macOS', /\bMac OS X\b/], ['ChromeOS', /\bCrOS\b/], ['Linux', /\bLinux\b/],
];

/** Determinístico e conservador: sem navegador reconhecível, nada é adivinhado (nunca modelo de aparelho). */
function origemDoDispositivo(dispositivo) {
  if (typeof dispositivo !== 'string' || dispositivo === '') return null;
  const navegador = NAVEGADORES.find(([, re]) => re.test(dispositivo));
  if (!navegador) return null;
  const sistema = SISTEMAS.find(([, re]) => re.test(dispositivo));
  return { navegador: navegador[0], sistema: sistema ? sistema[0] : null };
}

// ─── Referência amigável (só com mapeamento confiável por tipo de evento) ────────

const TIPO_POR_ACAO = Object.freeze({
  SOLICITACAO_EPI_CRIADA: 'PED',
  SOLICITACAO_EPI_DECIDIDA: 'PED',
  SOLICITACAO_EPI_CANCELADA: 'PED',
  SOLICITACAO_EPI_ENCERRADA: 'PED',
  SOLICITACAO_EPI_ENTREGUE: 'PED',
  ENTREGA_REGISTRADA: 'FIC',
  ESTOQUE_ENTRADA: 'EST',
  ESTOQUE_BAIXA: 'EST',
  MATERIAL_CRIADO: 'MAT',
  MATERIAL_ALTERADO: 'MAT',
  MATERIAL_INATIVADO: 'MAT',
  MATERIAL_REATIVADO: 'MAT',
  ESTOQUE_MINIMO_DEFINIDO: 'MAT',
  ESTOQUE_MINIMO_REMOVIDO: 'MAT',
  FUNCIONARIO_CRIADO: 'FUN',
  FUNCIONARIO_ALTERADO: 'FUN',
  FUNCIONARIO_INATIVADO: 'FUN',
  FUNCIONARIO_REATIVADO: 'FUN',
  FUNCIONARIO_CPF_CONSULTADO: 'FUN',
  USUARIO_CRIADO: 'USR',
  USUARIO_ALTERADO: 'USR',
  USUARIO_PERFIL_ALTERADO: 'USR',
  USUARIO_INATIVADO: 'USR',
  USUARIO_REATIVADO: 'USR',
  USUARIO_DADOS_ALTERADOS: 'USR',
  USUARIO_EMAIL_ALTERADO: 'USR',
  USUARIO_DADOS_CONSULTADOS: 'USR',
  USUARIO_ACESSO_ALTERADO: 'USR',
  USUARIO_PERMISSOES_COPIADAS: 'USR',
  VINCULO_SST_ADICIONADO: 'USR',
  VINCULO_SST_REMOVIDO: 'USR',
  USUARIO_VINCULADO_A_GRUPO: 'USR',
  USUARIO_TRANSFERIDO_DE_GRUPO: 'USR',
  USUARIO_DESVINCULADO_DE_GRUPO: 'USR',
});

const ID_INTEIRO = /^[1-9]\d{0,9}$/;
const idDaReferencia = (referencia) => {
  if (typeof referencia !== 'string' || !ID_INTEIRO.test(referencia)) return null;
  const n = Number(referencia);
  return n <= 2147483647 ? n : null;
};
const quatro = (n) => String(n).padStart(4, '0');

const RESOLVEDORES = Object.freeze({
  PED: { buscar: repo.nomesDeSolicitacoes, texto: (d) => `PED-${quatro(d.numero)} · ${d.nome}` },
  FIC: { buscar: repo.nomesDeEntregas, texto: (d) => `FIC-${quatro(d.numero)} · ${d.nome}` },
  EST: { buscar: repo.nomesDeLotes, texto: (d, id) => `EST-${quatro(id)} · ${d.nome}` },
  MAT: { buscar: repo.nomesDeMateriais, texto: (d, id) => `MAT-${quatro(id)} · ${d.nome}` },
  FUN: { buscar: repo.nomesDeFuncionarios, texto: (d, id) => `FUN-${quatro(id)} · ${d.nome}` },
  USR: { buscar: repo.nomesDeUsuarios, texto: (d, id) => `USR-${quatro(id)} · ${d.nome}` },
});

/** Resolve em lote, por tipo e sempre dentro da empresa da sessão; o que não resolve fica sem referência amigável. */
async function referenciasAmigaveis(executor, empresaId, linhas) {
  const porTipo = new Map();
  for (const l of linhas) {
    const tipo = TIPO_POR_ACAO[l.acao];
    const id = tipo ? idDaReferencia(l.referencia) : null;
    if (tipo && id !== null) {
      if (!porTipo.has(tipo)) porTipo.set(tipo, new Set());
      porTipo.get(tipo).add(id);
    }
  }
  const dados = new Map();
  await Promise.all([...porTipo.entries()].map(async ([tipo, ids]) => {
    dados.set(tipo, await RESOLVEDORES[tipo].buscar(executor, empresaId, [...ids]));
  }));
  return linhas.map((l) => {
    const tipo = TIPO_POR_ACAO[l.acao];
    const id = tipo ? idDaReferencia(l.referencia) : null;
    const d = tipo && id !== null ? dados.get(tipo).get(id) : undefined;
    return d === undefined ? null : RESOLVEDORES[tipo].texto(d, id);
  });
}

// ─── Consultas ──────────────────────────────────────────────────────

async function indicadores(pool, { empresaId }, agora = new Date()) {
  const hoje = dataOperacional(agora);
  const [pendentes, reprovados, ca, logs] = await Promise.all([
    repo.contarItensPendentes(pool, empresaId),
    repo.contarItensReprovados(pool, empresaId),
    loteRepo.resumirIndicadores(pool, empresaId, { hoje, diasAlerta: DIAS_ALERTA_VALIDADE_CA }),
    repo.contarLogsDosUltimosDias(pool, empresaId, 30),
  ]);
  return {
    indicadores: {
      // Itens aprovados ainda a entregar: uma linha de item = 1 (nunca unidades).
      entregasPendentes: pendentes,
      // Itens reprovados pela SST, em qualquer status da solicitação (histórico).
      itensReprovados: reprovados,
      caVencidosEmEstoque: ca.caVencido,
      logs30Dias: logs,
    },
  };
}

async function solicitacoesNaoAtendidas(pool, {
  empresaId, funcionario = null, item = null, status = null, ordem = 'diasEmFila', direcao = 'desc', pagina, limite,
}) {
  const filtros = { padraoFuncionario: padraoParcial(funcionario), padraoItem: padraoParcial(item), status };
  const [itens, total] = await Promise.all([
    repo.listarSolicitacoesNaoAtendidas(pool, empresaId, filtros, { ordem, direcao, pagina, limite }),
    repo.contarSolicitacoesNaoAtendidas(pool, empresaId, filtros),
  ]);
  return { itens, total, pagina, limite };
}

async function solicitacoesReprovadas(pool, {
  empresaId, funcionario = null, item = null, de = null, ate = null, ordem = 'dataReprovacao', direcao = 'desc', pagina, limite,
}) {
  const filtros = { de, ate, padraoFuncionario: padraoParcial(funcionario), padraoItem: padraoParcial(item) };
  const [itens, total] = await Promise.all([
    repo.listarReprovados(pool, empresaId, filtros, { ordem, direcao, pagina, limite }),
    repo.contarReprovados(pool, empresaId, filtros),
  ]);
  return { itens, total, pagina, limite };
}

/**
 * Resumo dos lotes com CA vencido que ainda têm saldo, a mesma população do card e da tela Validade de Estoque
 * (`situacao = VENCIDO`, a regra oficial reutilizada, sem segunda lógica). "Quantidade disponível" é o saldo ATUAL do lote
 * (entrada menos baixas e entregas), nunca a quantidade de entrada. O modal pede só as primeiras linhas; `total` diz quantas
 * existem. Somente informativo: nada aqui baixa estoque; a tratativa é da tela Validade de Estoque.
 */
async function caVencidos(pool, { empresaId, pagina, limite }, agora = new Date()) {
  const referencia = { hoje: dataOperacional(agora), diasAlerta: DIAS_ALERTA_VALIDADE_CA };
  const [lotes, total] = await Promise.all([
    loteRepo.listarValidade(pool, empresaId, { ...referencia, pagina, limite, situacao: 'VENCIDO' }),
    loteRepo.contarValidade(pool, empresaId, { ...referencia, situacao: 'VENCIDO' }),
  ]);
  const itens = lotes.map((l) => ({
    loteId: l.loteId,
    material: l.material,
    tamanho: l.tamanho,
    caNumero: l.caNumero,
    caValidade: l.caValidade,
    quantidadeDisponivel: l.fisico,
  }));
  return { itens, total, pagina, limite };
}

/** Só valores booleanos dos filtros, nunca o conteúdo digitado (pode conter dado pessoal). */
const contextoDaConsulta = (f, pagina) => ({
  filtros: { periodo: f.de !== null || f.ate !== null, usuario: f.usuario !== null, acao: f.acao !== null, referencia: f.busca !== null },
  pagina,
});

async function log(pool, {
  empresaId, atorId, ip = null, dispositivo = null, de = null, ate = null, usuario = null, acao = null, busca = null,
  ordem = 'dataHora', direcao = 'desc', pagina, limite,
}, agora = new Date()) {
  const periodo = periodoDoLog({ de, ate }, dataOperacional(agora));
  const filtros = {
    ...periodo, padraoUsuario: padraoParcial(usuario), padraoAcao: padraoParcial(acao), padraoReferencia: padraoParcial(busca),
  };
  const [linhas, total] = await Promise.all([
    repo.listarLog(pool, empresaId, filtros, { ordem, direcao, pagina, limite }),
    repo.contarLog(pool, empresaId, filtros),
  ]);
  const amigaveis = await referenciasAmigaveis(pool, empresaId, linhas);
  const itens = linhas.map((l, i) => ({
    id: l.id,
    criadoEm: l.criadoEm,
    usuario: l.usuarioId === null ? null : { id: l.usuarioId, nome: l.usuarioNome },
    automatico: l.usuarioId === null,
    perfil: l.perfilAtor,
    acao: l.acao,
    referencia: l.referencia,
    referenciaAmigavel: amigaveis[i],
    ip: l.ip,
    dispositivo: l.dispositivo,
    origem: origemDoDispositivo(l.dispositivo),
  }));

  // A consulta à trilha é auditada, com supressão: no máximo uma linha por usuário na janela, e a leitura não gera a si mesma
  // (a escrita acontece depois da leitura e não dispara nova consulta). Só ids e booleanos entram no registro.
  if (Number.isInteger(atorId)) {
    const recente = await auditoriaRepo.existeRecente(pool, {
      empresaId, usuarioId: atorId, acao: ACAO_CONSULTA, referencia: 'trilha', janelaSegundos: JANELA_AUDITORIA_CONSULTA_S,
    });
    if (!recente) {
      await auditoriaRepo.registrar(pool, {
        empresaId, usuarioId: atorId, acao: ACAO_CONSULTA, referencia: 'trilha', ip, dispositivo, contexto: contextoDaConsulta({
          de, ate, usuario, acao, busca,
        }, pagina),
      });
    }
  }
  return { itens, total, pagina, limite, periodo };
}

module.exports = {
  indicadores,
  solicitacoesNaoAtendidas,
  solicitacoesReprovadas,
  caVencidos,
  log,
  origemDoDispositivo,
  periodoDoLog,
  referenciasAmigaveis,
  TIPO_POR_ACAO,
  PERIODO_MAXIMO_DIAS,
  ACAO_CONSULTA,
};
