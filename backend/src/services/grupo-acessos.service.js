'use strict';

const { HttpError } = require('../errors/HttpError');
const grupoPermissaoService = require('./grupo-permissao.service');
const grupoRepo = require('../repositories/grupo-acesso.repository');
const permissaoRepo = require('../repositories/permissao.repository');
const toggles = require('../rbac/toggles');
const { avisosDosAcessos } = require('../rbac/avisos-acessos');
const { descreverDependencia } = require('../rbac/dependencias-acessos');

/**
 * Acessos ON/OFF de um GRUPO: visão binária sobre as mesmas permissões de grupo (grupo_permissoes_recurso e
 * grupo_permissoes_acao), pelo serviço existente (autoridade, trava, auditoria e isolamento por empresa são os dele).
 *
 * ON = o grupo concede; OFF = o grupo não concede (opinião retirada: null, nunca `false`, que bloquearia o que o
 * perfil permite). Só entram os acessos do catálogo com enforcement real e que o grupo consegue de fato conceder:
 * ação fora do modo ALTERNATIVA (ex.: GERENCIAR_USUARIOS) não aceita concessão por grupo e ficaria decorativa.
 * Ligar também concede, no grupo, a leitura de que o acesso depende; desligar mexe só na regra própria.
 */
const MODO_ALTERNATIVA = 'ALTERNATIVA';
const ERRO_TOGGLE = ['TOGGLE_NAO_ENCONTRADO', 'Acesso não encontrado'];
const AVISO_DEPENDENCIA_REABILITADA = 'DEPENDENCIA_REABILITADA';
const FLAG = { visualizar: 'podeVisualizar', criar: 'podeCriar', editar: 'podeEditar', excluir: 'podeExcluir' };

async function acessosDisponiveis(pool) {
  const lista = [];
  for (const t of toggles.TOGGLES) {
    if (t.regra.tipo === 'ACAO') {
      const configuracao = await permissaoRepo.buscarConfiguracaoAcao(pool, t.regra.codigo);
      if (configuracao === null || configuracao.ativo !== true || configuracao.modoAutorizacaoIndividual !== MODO_ALTERNATIVA) continue;
    }
    lista.push(t);
  }
  return lista;
}

const ligadoNoGrupo = (regra, recursosDoGrupo, acoesDoGrupo) => {
  if (regra.tipo === 'ACAO') return acoesDoGrupo.some((a) => a.acaoCodigo === regra.codigo && a.permitido === true);
  const linha = recursosDoGrupo.find((r) => r.recurso === regra.recurso);
  return linha !== undefined && regra.operacoes.every((op) => linha[FLAG[op]] === true);
};

async function detalhar(pool, { empresaId, atorId, grupoId }) {
  const recursosDoGrupo = await grupoPermissaoService.listarRecursos(pool, { empresaId, atorId, grupoId });
  const acoesDoGrupo = await grupoPermissaoService.listarAcoes(pool, { empresaId, atorId, grupoId });
  const grupo = await grupoRepo.buscarPorId(pool, empresaId, grupoId);
  if (grupo === null) throw HttpError.notFound('GRUPO_NAO_ENCONTRADO', 'Grupo não encontrado');
  const lista = (await acessosDisponiveis(pool)).map((t) => ({
    id: t.id, rotulo: t.rotulo, grupo: t.grupo, ligado: ligadoNoGrupo(t.regra, recursosDoGrupo, acoesDoGrupo),
  }));
  // Avisos sobre a CONFIGURAÇÃO do grupo (o que ele concede), não sobre o efeito nos integrantes.
  return { grupo: { id: grupo.id, nome: grupo.nome, ativo: grupo.ativo }, toggles: lista, avisos: avisosDosAcessos(lista) };
}

async function aplicarRegra(pool, base, regra, ligado, contextoExtra = null) {
  if (regra.tipo === 'ACAO') {
    await grupoPermissaoService.configurarAcao(pool, { ...base, acaoCodigo: regra.codigo, permitido: ligado ? true : null });
    return;
  }
  const flags = Object.fromEntries(regra.operacoes.map((op) => [FLAG[op], ligado ? true : null]));
  await grupoPermissaoService.configurarRecurso(pool, {
    ...base, recurso: regra.recurso, ...flags, ...(contextoExtra === null ? {} : { contextoExtra }),
  });
}

/** O grupo NEGA explicitamente a dependência (`false`)? Só dado legado/API antiga: o toggle nunca grava `false`. */
async function dependenciaNegada(pool, base, dependencia) {
  if (dependencia.tipo !== 'RECURSO') return false;
  const recursosDoGrupo = await grupoPermissaoService.listarRecursos(pool, { empresaId: base.empresaId, atorId: base.atorId, grupoId: base.grupoId });
  const linha = recursosDoGrupo.find((r) => r.recurso === dependencia.recurso);
  return linha !== undefined && dependencia.operacoes.some((op) => linha[FLAG[op]] === false);
}

async function configurarToggle(pool, {
  empresaId, atorId, grupoId, toggleId, ligado, ip = null, dispositivo = null,
}) {
  if (typeof ligado !== 'boolean') throw new TypeError('ligado inválido');
  const toggle = (await acessosDisponiveis(pool)).find((t) => t.id === toggleId);
  if (toggle === undefined) throw HttpError.notFound(...ERRO_TOGGLE);
  const base = {
    empresaId, atorId, grupoId, ip, dispositivo,
  };
  // Transparência (não decide nada): o estado de todos os acessos e das dependências ANTES, para devolver `alterados` e avisar.
  const anterior = await detalhar(pool, { empresaId, atorId, grupoId });
  const dependencias = [];
  if (ligado) {
    for (const regra of toggle.dependencias ?? []) {
      dependencias.push({ regra, ...descreverDependencia(regra), negada: await dependenciaNegada(pool, base, regra) });
    }
  }
  // A dependência (leitura) vem primeiro: se a regra própria falhar, sobra só uma leitura a mais.
  // Cada dependência que muda de verdade é auditada pelo serviço de permissões de grupo, agora ligada à operação original.
  if (ligado) {
    for (const regra of toggle.dependencias ?? []) {
      await aplicarRegra(pool, base, regra, true, { causa: 'dependencia', acessoOrigem: toggleId });
    }
  }
  await aplicarRegra(pool, base, toggle.regra, ligado);
  const atual = await detalhar(pool, { empresaId, atorId, grupoId });
  const antesPorId = new Map(anterior.toggles.map((t) => [t.id, t.ligado]));
  const alterados = atual.toggles.filter((t) => antesPorId.get(t.id) !== t.ligado);
  // Reabilitada = o grupo NEGAVA a leitura e agora a concede.
  const reabilitadas = dependencias.filter((d) => d.negada).map((d) => d.rotulo);
  const avisos = reabilitadas.length > 0 ? [...atual.avisos, { codigo: AVISO_DEPENDENCIA_REABILITADA, acessos: reabilitadas }] : atual.avisos;
  return { acesso: atual.toggles.find((t) => t.id === toggleId), avisos, alterados };
}

module.exports = { detalhar, configurarToggle };
