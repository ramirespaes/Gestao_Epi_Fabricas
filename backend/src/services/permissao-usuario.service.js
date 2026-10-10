'use strict';

const { HttpError } = require('../errors/HttpError');
const autoridade = require('./autoridade-administrativa');
const usuarioAdministracao = require('./usuario-administracao.service');
const autorizacaoIndividual = require('./autorizacao-individual.service');
const copiaAcesso = require('./copia-acesso.service');
const autorizacao = require('../middleware/autorizacao');
const repo = require('../repositories/usuario-administracao.repository');
const permissaoRepo = require('../repositories/permissao.repository');
const permissaoIndividualRepo = require('../repositories/permissao-individual.repository');
const autorizacaoRepo = require('../repositories/autorizacao-individual.repository');
const grupoAcessoRepo = require('../repositories/grupo-acesso.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { RECURSOS_COM_EFEITO, ACOES_COM_EFEITO } = require('../rbac/recursos');
const toggles = require('../rbac/toggles');

/**
 * Permissões do usuário na Gestão de Usuários: leitura em camadas e escrita
 * das camadas INDIVIDUAIS (tabelas já existentes; sem migration).
 *
 * PERFIL != PERMISSÃO. O resultado EFETIVO nunca é calculado aqui: é o de
 * autorizacao.avaliarPermissaoRecurso/Acao, as mesmas funções do middleware,
 * perguntadas para o usuário-alvo. A "origem" de cada célula usa as funções
 * puras opiniaoIndividual/opiniaoDoGrupo do mesmo módulo. O catálogo vem do
 * backend: recursos/operações que alguma rota exige de fato (RECURSOS_COM_EFEITO)
 * e todas as ações da tabela acoes.
 *
 * AUTORIDADE. Ler: quem administra usuários (GERENCIAR_USUARIOS) e só usuários
 * que o ator pode gerenciar (D3). Escrever as camadas individuais: SÓ o MASTER
 * ativo (é o que a 3I já exige para conceder direto), e nunca no próprio MASTER
 * (autoridade própria, fixa): ninguém concede o que não tem legitimidade para
 * administrar. Delegação (3I) e SST não mudam: uma concessão de ação com
 * vínculo SST exigido continua dependendo do vínculo para valer.
 */

const PERFIL_MASTER = 'MASTER';
const MODOS_CONCEDIVEIS = ['ALTERNATIVA', 'OBRIGATORIA'];
const ESTADOS = Object.freeze(['PADRAO', 'CONCEDIDA', 'BLOQUEADA']);
const OPERACOES = ['visualizar', 'criar', 'editar', 'excluir'];
const FLAG = { visualizar: 'podeVisualizar', criar: 'podeCriar', editar: 'podeEditar', excluir: 'podeExcluir' };
const ACOES_SEM_AUTODECISAO = Object.freeze(['APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO']);
const ACAO_AUDITORIA = Object.freeze({
  RECURSO: 'USUARIO_PERMISSAO_RECURSO_ALTERADA',
  ACAO: 'USUARIO_PERMISSAO_ACAO_ALTERADA',
  COPIA: 'USUARIO_PERMISSOES_COPIADAS',
  TOGGLE: 'USUARIO_ACESSO_ALTERADO',
});
const ERRO = Object.freeze({
  NAO_AUTORIZADO: ['USUARIO_ADMINISTRACAO_NAO_AUTORIZADA', 'Sem autoridade para administrar os usuários da empresa'],
  NAO_ENCONTRADO: ['USUARIO_NAO_ENCONTRADO', 'Usuário não encontrado'],
  SOMENTE_MASTER: ['PERMISSOES_INDIVIDUAIS_SOMENTE_MASTER', 'Somente o Master altera as permissões individuais'],
  MASTER_FIXO: ['USUARIO_MASTER_PERMISSOES_FIXAS', 'O Master tem autoridade própria: as permissões dele não são configuráveis'],
  RECURSO: ['RECURSO_NAO_ENCONTRADO', 'Recurso não encontrado'],
  OPERACAO: ['OPERACAO_SEM_EFEITO', 'Esta operação não é exigida por nenhuma função do sistema para este recurso'],
  ACAO: ['ACAO_NAO_ENCONTRADA', 'Ação não encontrada'],
  NAO_CONCEDIVEL: ['ACAO_NAO_CONCEDIVEL', 'Esta ação não aceita concessão individual'],
  ORIGEM: ['USUARIO_ORIGEM_NAO_ENCONTRADO', 'Usuário de origem não encontrado'],
  MESMO: ['COPIA_PARA_O_PROPRIO_USUARIO', 'Origem e destino precisam ser usuários diferentes'],
  GRUPO_INATIVO: ['GRUPO_INATIVO', 'Grupo inativo não recebe novos vínculos'],
});

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

const motivoSomenteLeitura = (ator, alvo) => {
  if (alvo.perfil === PERFIL_MASTER) return 'USUARIO_MASTER';
  if (ator.perfil !== PERFIL_MASTER) return 'SOMENTE_MASTER';
  return null;
};

async function celulaDeRecurso(executor, ctx, alvo, grupo, entrada) {
  const perfil = await permissaoRepo.buscarPermissaoRecurso(executor, ctx.empresaId, alvo.perfil, entrada.recurso);
  const doGrupo = grupo === null ? null : await permissaoRepo.buscarPermissaoRecursoGrupo(executor, ctx.empresaId, grupo.id, entrada.recurso);
  const individual = await permissaoRepo.buscarPermissaoRecursoIndividual(executor, ctx.empresaId, alvo.id, entrada.recurso);
  const efetivo = await autorizacao.avaliarPermissaoRecurso(executor, { empresaId: ctx.empresaId, usuarioId: alvo.id, perfil: alvo.perfil }, entrada.recurso);
  const operacoes = {};
  for (const op of entrada.operacoes) {
    const valorGrupo = doGrupo === null ? null : doGrupo[FLAG[op]];
    const valorIndividual = individual === null ? null : individual[FLAG[op]];
    let origem = 'PERFIL';
    if (alvo.perfil !== PERFIL_MASTER) {
      if (autorizacao.opiniaoIndividual(valorIndividual) !== undefined) origem = 'INDIVIDUAL';
      else if (autorizacao.opiniaoDoGrupo(grupo, valorGrupo) !== undefined) origem = 'GRUPO';
    }
    operacoes[op] = {
      perfil: perfil !== null && perfil[FLAG[op]] === true,
      grupo: alvo.perfil === PERFIL_MASTER ? null : valorGrupo,
      individual: alvo.perfil === PERFIL_MASTER ? null : valorIndividual,
      efetivo: efetivo[op] === true,
      origem,
    };
  }
  return { recurso: entrada.recurso, rotulo: entrada.rotulo, operacoes };
}

async function celulaDeAcao(executor, ctx, alvo, catalogo, contexto) {
  const { empresaId } = ctx;
  const efetivo = await autorizacao.avaliarPermissaoAcao(executor, { empresaId, usuarioId: alvo.id, perfil: alvo.perfil }, catalogo.codigo);
  const perfil = await permissaoRepo.buscarPermissaoAcao(executor, empresaId, alvo.perfil, catalogo.codigo);
  const doGrupo = contexto.grupo === null ? null : await permissaoRepo.buscarPermissaoAcaoGrupo(executor, empresaId, contexto.grupo.id, catalogo.codigo);
  const concessoes = contexto.autorizacoes.filter((a) => a.acaoCodigo === catalogo.codigo);
  const direta = concessoes.some((a) => a.origemId === null);
  const bloqueada = contexto.bloqueios.includes(catalogo.codigo);
  const master = alvo.perfil === PERFIL_MASTER;
  const concedivel = catalogo.ativo === true && MODOS_CONCEDIVEIS.includes(catalogo.modoAutorizacaoIndividual);
  let estado = 'PADRAO';
  if (bloqueada) estado = 'BLOQUEADA';
  else if (direta) estado = 'CONCEDIDA';
  let motivoNegado = null;
  if (!efetivo) {
    if (bloqueada) motivoNegado = 'BLOQUEIO_INDIVIDUAL';
    else if (!catalogo.ativo) motivoNegado = 'ACAO_INATIVA';
    else if (catalogo.exigeSst && !master && !contexto.sst && (concessoes.length > 0 || (perfil !== null && perfil.permitido === true))) motivoNegado = 'SEM_VINCULO_SST';
    else motivoNegado = 'NAO_CONCEDIDA';
  }
  const regras = [];
  if (catalogo.exigeSst) regras.push('SST');
  if (ACOES_SEM_AUTODECISAO.includes(catalogo.codigo)) regras.push('AUTODECISAO_PROIBIDA');
  const estadosPermitidos = [];
  if (!master && catalogo.ativo === true) {
    estadosPermitidos.push('PADRAO', 'BLOQUEADA');
    if (concedivel) estadosPermitidos.push('CONCEDIDA');
  }
  return {
    codigo: catalogo.codigo,
    nome: catalogo.nome,
    descricao: catalogo.descricao,
    ativa: catalogo.ativo,
    modo: catalogo.modoAutorizacaoIndividual,
    exigeSst: catalogo.exigeSst,
    regras,
    perfil: perfil === null ? null : perfil.permitido === true,
    grupo: doGrupo === null ? null : doGrupo.permitido,
    estado,
    concedidaPorDelegacao: concessoes.some((a) => a.origemId !== null),
    vinculoSst: contexto.sst,
    efetivo,
    motivoNegado,
    estadosPermitidos,
  };
}

async function montar(executor, ator, empresaId, alvo) {
  const grupoInfo = await permissaoRepo.buscarGrupoAcessoDoUsuario(executor, empresaId, alvo.id);
  const grupo = grupoInfo === null ? null : grupoInfo;
  const grupoCompleto = grupoInfo === null ? null : await grupoAcessoRepo.buscarPorId(executor, empresaId, grupoInfo.id);
  const ctx = { empresaId };
  const recursos = [];
  for (const entrada of RECURSOS_COM_EFEITO) {
    recursos.push(await celulaDeRecurso(executor, ctx, alvo, grupo, entrada));
  }
  const contexto = {
    grupo,
    autorizacoes: await autorizacaoRepo.listarPorUsuario(executor, empresaId, alvo.id),
    bloqueios: await permissaoIndividualRepo.listarBloqueios(executor, empresaId, alvo.id),
    sst: await permissaoRepo.usuarioIntegraSst(executor, empresaId, alvo.id),
  };
  const catalogo = (await permissaoRepo.listarAcoes(executor)).filter((a) => ACOES_COM_EFEITO.includes(a.codigo));
  const acoes = [];
  for (const a of catalogo) {
    acoes.push(await celulaDeAcao(executor, ctx, alvo, a, contexto));
  }
  const individuais = await permissaoIndividualRepo.listarRecursos(executor, empresaId, alvo.id);
  const motivo = motivoSomenteLeitura(ator, alvo);
  return {
    usuario: { id: alvo.id, nome: alvo.nome, perfil: alvo.perfil, ativo: alvo.ativo },
    podeAlterar: motivo === null,
    motivoSomenteLeitura: motivo,
    grupo: grupoCompleto === null ? null : { nome: grupoCompleto.nome, ativo: grupoCompleto.ativo },
    recursos,
    acoes,
    resumoIndividual: {
      recursos: individuais.length,
      autorizacoes: contexto.autorizacoes.filter((a) => a.origemId === null).length,
      bloqueios: contexto.bloqueios.length,
    },
  };
}

async function carregarAlvo(executor, empresaId, usuarioId, opcoes) {
  const alvo = await repo.buscarDadosParaEdicao(executor, empresaId, usuarioId, opcoes);
  if (alvo === null) {
    throw HttpError.notFound(...ERRO.NAO_ENCONTRADO);
  }
  return alvo;
}

async function detalhar(pool, { empresaId, atorId, usuarioId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(usuarioId, 'identificador de usuário');
  const ator = await autoridade.exigirAutoridadeAdministrativaLeitura(
    pool, empresaId, atorId, ...ERRO.NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.USUARIOS,
  );
  const alvo = await carregarAlvo(pool, empresaId, usuarioId, {});
  usuarioAdministracao.exigirPerfilGerenciavel(ator, alvo.perfil);
  return montar(pool, ator, empresaId, alvo);
}

/** Esqueleto das escritas: trava da empresa, autoridade, MASTER-only, alvo travado e não-MASTER. */
async function escrever(pool, { empresaId, atorId, usuarioId }, operacao) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(usuarioId, 'identificador de usuário');
  return usuarioAdministracao.emTransacao(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [usuarioAdministracao.travaDaEmpresa(empresaId)]);
    const ator = await autoridade.exigirAutoridadeAdministrativa(
      client, empresaId, atorId, ...ERRO.NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.USUARIOS,
    );
    const alvo = await carregarAlvo(client, empresaId, usuarioId, { travar: true });
    usuarioAdministracao.exigirPerfilGerenciavel(ator, alvo.perfil);
    if (ator.perfil !== PERFIL_MASTER) {
      throw HttpError.forbidden(...ERRO.SOMENTE_MASTER);
    }
    if (alvo.perfil === PERFIL_MASTER) {
      throw HttpError.conflict(...ERRO.MASTER_FIXO);
    }
    return operacao(client, ator, alvo);
  });
}

async function auditar(client, { empresaId, atorId, alvoId, acao, antes, depois, ip, dispositivo }) {
  await auditoriaRepo.registrar(client, {
    empresaId, usuarioId: atorId, acao, referencia: String(alvoId), ip, dispositivo, contexto: { origem: 'administracao_usuarios' }, dadosAnteriores: antes, dadosNovos: depois,
  });
}

async function configurarRecurso(pool, {
  empresaId, atorId, usuarioId, recurso, flags, ip = null, dispositivo = null,
}) {
  return escrever(pool, { empresaId, atorId, usuarioId }, async (client, ator, alvo) => {
    const entrada = RECURSOS_COM_EFEITO.find((r) => r.recurso === recurso);
    if (entrada === undefined) {
      throw HttpError.notFound(...ERRO.RECURSO);
    }
    for (const op of Object.keys(flags)) {
      if (!entrada.operacoes.includes(op)) {
        throw HttpError.badRequest(...ERRO.OPERACAO);
      }
    }
    // Funcionários: conceder criar ou editar garante a leitura na atribuição (mesmas dependências dos toggles). O pedido que concede e
    // nega a leitura (false) ou manda limpá-la (null EXPLÍCITO) ao mesmo tempo é contraditório e é recusado antes de qualquer escrita;
    // campo OMITIDO é outra coisa: aplica a dependência. Quando o pedido não fala de visualizar e a
    // leitura efetiva ainda é negada (inclusive por uma negação anterior: a concessão nova é uma decisão nova), a leitura passa a true.
    const concedidas = ['criar', 'editar'].filter((op) => flags[op] === true);
    const garantidas = toggles.operacoesGarantidasNaAtribuicaoDireta(recurso, concedidas);
    if (garantidas.includes('visualizar') && (flags.visualizar === false || flags.visualizar === null)) {
      throw HttpError.validacao([{ campo: 'body.visualizar', codigo: 'VALOR_NAO_PERMITIDO', mensagem: 'Conceder criar ou editar exige a leitura: não envie visualizar=false nem visualizar=null no mesmo pedido' }]);
    }
    const antes = (await permissaoIndividualRepo.listarRecursos(client, empresaId, alvo.id)).find((r) => r.recurso === recurso) ?? null;
    const flagsFinais = { ...flags };
    if (garantidas.includes('visualizar') && flags.visualizar === undefined) {
      const efetivo = await autorizacao.avaliarPermissaoRecurso(client, { empresaId, usuarioId: alvo.id, perfil: alvo.perfil }, recurso);
      if (efetivo.visualizar !== true) flagsFinais.visualizar = true;
    }
    const depois = await permissaoIndividualRepo.definirRecurso(client, {
      empresaId, usuarioId: alvo.id, recurso, flags: flagsFinais, concedidoPor: ator.id,
    });
    await auditar(client, {
      empresaId, atorId: ator.id, alvoId: alvo.id, acao: ACAO_AUDITORIA.RECURSO, ip, dispositivo,
      antes: { recurso, ...(antes === null ? {} : { visualizar: antes.visualizar, criar: antes.criar, editar: antes.editar, excluir: antes.excluir }) },
      depois: { recurso, ...(depois === null ? {} : { visualizar: depois.visualizar, criar: depois.criar, editar: depois.editar, excluir: depois.excluir }) },
    });
    const completo = await montar(client, ator, empresaId, alvo);
    return completo.recursos.find((r) => r.recurso === recurso);
  });
}

async function configurarAcao(pool, {
  empresaId, atorId, usuarioId, acaoCodigo, estado, ip = null, dispositivo = null,
}) {
  if (!ESTADOS.includes(estado)) {
    throw new TypeError('estado inválido');
  }
  return escrever(pool, { empresaId, atorId, usuarioId }, (client, ator, alvo) => aplicarAcao(client, {
    empresaId, ator, alvo, acaoCodigo, estado, ip, dispositivo,
  }));
}

/** Aplica o estado individual de uma ação dentro da transação já aberta pelo esqueleto das escritas. */
async function aplicarAcao(client, {
  empresaId, ator, alvo, acaoCodigo, estado, ip, dispositivo,
}) {
  {
    const catalogo = (await permissaoRepo.listarAcoes(client)).find((a) => a.codigo === acaoCodigo && ACOES_COM_EFEITO.includes(a.codigo));
    if (catalogo === undefined) {
      throw HttpError.notFound(...ERRO.ACAO);
    }
    if (estado === 'CONCEDIDA' && !(catalogo.ativo === true && MODOS_CONCEDIVEIS.includes(catalogo.modoAutorizacaoIndividual))) {
      throw HttpError.conflict(...ERRO.NAO_CONCEDIVEL);
    }
    const pool2 = copiaAcesso.poolSobre(client);
    const anterior = (await montar(client, ator, empresaId, alvo)).acoes.find((a) => a.codigo === acaoCodigo).estado;
    const diretas = (await autorizacaoRepo.listarPorUsuario(client, empresaId, alvo.id)).filter((a) => a.acaoCodigo === acaoCodigo && a.origemId === null);
    const bloqueada = (await permissaoIndividualRepo.listarBloqueios(client, empresaId, alvo.id)).includes(acaoCodigo);

    if (estado !== 'CONCEDIDA') {
      for (const d of diretas) {
        await autorizacaoIndividual.revogar(pool2, {
          empresaId, revogadoPor: ator.id, autorizacaoId: d.id, motivo: null, ip, dispositivo,
        });
      }
    }
    if (estado === 'BLOQUEADA' && !bloqueada) {
      await permissaoIndividualRepo.bloquear(client, { empresaId, usuarioId: alvo.id, acaoCodigo, bloqueadoPor: ator.id });
    }
    if (estado !== 'BLOQUEADA' && bloqueada) {
      await permissaoIndividualRepo.desbloquear(client, { empresaId, usuarioId: alvo.id, acaoCodigo });
    }
    if (estado === 'CONCEDIDA' && diretas.length === 0) {
      await autorizacaoIndividual.concederDireta(pool2, {
        empresaId, concedidoPor: ator.id, usuarioId: alvo.id, acaoCodigo, podeDelegar: false, motivo: null, ip, dispositivo,
      });
    }
    if (anterior !== estado) {
      await auditar(client, {
        empresaId, atorId: ator.id, alvoId: alvo.id, acao: ACAO_AUDITORIA.ACAO, ip, dispositivo, antes: { acao: acaoCodigo, estado: anterior }, depois: { acao: acaoCodigo, estado },
      });
    }
    const completo = await montar(client, ator, empresaId, alvo);
    return completo.acoes.find((a) => a.codigo === acaoCodigo);
  }
}

const ERRO_TOGGLE = ['TOGGLE_NAO_ENCONTRADO', 'Acesso não encontrado'];

const efetivoDoToggle = (completo, regra) => {
  // Toggle de CONCESSÃO (decisão da SST): ligado = há concessão individual direta, com ou sem vínculo SST; o efeito final
  // continua exigindo o vínculo e é decidido pelo servidor.
  if (regra.tipo === 'ACAO' && regra.concessao === true) return completo.acoes.find((a) => a.codigo === regra.codigo)?.estado === 'CONCEDIDA';
  if (regra.tipo === 'ACAO') return completo.acoes.find((a) => a.codigo === regra.codigo)?.efetivo === true;
  const celula = completo.recursos.find((r) => r.recurso === regra.recurso);
  return celula !== undefined && regra.operacoes.every((op) => celula.operacoes[op]?.efetivo === true);
};

/** Visão binária: cada acesso do catálogo aprovado, ligado quando o efeito real é permitido (todas as regras dele). */
function resumirToggles(completo) {
  const fixo = completo.usuario.perfil === PERFIL_MASTER;
  return {
    usuario: completo.usuario,
    podeAlterar: completo.podeAlterar,
    motivoSomenteLeitura: completo.motivoSomenteLeitura,
    toggles: toggles.TOGGLES.map((t) => {
      const base = {
        id: t.id, rotulo: t.rotulo, grupo: t.grupo, ligado: efetivoDoToggle(completo, t.regra), fixo,
      };
      if (t.regra.concessao !== true || completo.acoes.find((a) => a.codigo === t.regra.codigo)?.exigeSst !== true) return base;
      // O vínculo SST do alvo vem junto, para a tela avisar que a permissão sozinha não basta.
      const celula = completo.acoes.find((a) => a.codigo === t.regra.codigo);
      return { ...base, exigeVinculoSst: true, vinculoSst: celula?.vinculoSst === true };
    }),
    pendencias: toggles.PENDENCIAS,
  };
}

async function detalharToggles(pool, dados) {
  return resumirToggles(await detalhar(pool, dados));
}

/** Leva UMA regra (ação ou recurso/operações) ao resultado efetivo pedido, com o mínimo de exceção individual. */
async function ajustarRegra(client, {
  empresaId, ator, alvo, ip, dispositivo,
}, regra, ligado) {
  if (regra.tipo === 'ACAO' && regra.concessao === true) {
    await aplicarAcao(client, {
      empresaId, ator, alvo, acaoCodigo: regra.codigo, estado: ligado ? 'CONCEDIDA' : 'PADRAO', ip, dispositivo,
    });
    return;
  }
  if (regra.tipo === 'ACAO' && regra.semBloqueio === true && ligado === false) {
    // Só remove a concessão individual (e um bloqueio antigo): a autoridade que vem de outra camada continua valendo.
    await aplicarAcao(client, {
      empresaId, ator, alvo, acaoCodigo: regra.codigo, estado: 'PADRAO', ip, dispositivo,
    });
    return;
  }
  if (regra.tipo === 'ACAO') {
    await aplicarAcao(client, {
      empresaId, ator, alvo, acaoCodigo: regra.codigo, estado: 'PADRAO', ip, dispositivo,
    });
    if (efetivoDoToggle(await montar(client, ator, empresaId, alvo), regra) !== ligado) {
      await aplicarAcao(client, {
        empresaId, ator, alvo, acaoCodigo: regra.codigo, estado: ligado ? 'CONCEDIDA' : 'BLOQUEADA', ip, dispositivo,
      });
    }
    return;
  }
  const limpar = Object.fromEntries(regra.operacoes.map((op) => [op, null]));
  await permissaoIndividualRepo.definirRecurso(client, {
    empresaId, usuarioId: alvo.id, recurso: regra.recurso, flags: limpar, concedidoPor: ator.id,
  });
  const celula = (await montar(client, ator, empresaId, alvo)).recursos.find((r) => r.recurso === regra.recurso);
  const ajustes = {};
  for (const op of regra.operacoes) {
    if (celula.operacoes[op].efetivo !== ligado) ajustes[op] = ligado;
  }
  if (Object.keys(ajustes).length > 0) {
    await permissaoIndividualRepo.definirRecurso(client, {
      empresaId, usuarioId: alvo.id, recurso: regra.recurso, flags: ajustes, concedidoPor: ator.id,
    });
  }
}

/**
 * Liga ou desliga um acesso pelo RESULTADO desejado. Primeiro volta a camada individual ao padrão (herda perfil e
 * grupo); só se o efeito real ainda diferir do pedido grava a exceção individual (concessão ou bloqueio). Assim não
 * sobra exceção redundante quando o estado desejado já é o herdado.
 */
async function configurarToggle(pool, {
  empresaId, atorId, usuarioId, toggleId, ligado, ip = null, dispositivo = null,
}) {
  if (typeof ligado !== 'boolean') throw new TypeError('ligado inválido');
  return escrever(pool, { empresaId, atorId, usuarioId }, async (client, ator, alvo) => {
    const toggle = toggles.buscar(toggleId);
    if (toggle === null) throw HttpError.notFound(...ERRO_TOGGLE);
    const antes = efetivoDoToggle(await montar(client, ator, empresaId, alvo), toggle.regra);
    const { regra } = toggle;
    const base = { empresaId, ator, alvo, ip, dispositivo };
    await ajustarRegra(client, base, regra, ligado);
    if (ligado) {
      for (const dependencia of toggle.dependencias ?? []) {
        if (!efetivoDoToggle(await montar(client, ator, empresaId, alvo), dependencia)) {
          await ajustarRegra(client, base, dependencia, true);
        }
      }
    }
    const completo = await montar(client, ator, empresaId, alvo);
    const depois = efetivoDoToggle(completo, regra);
    if (antes !== depois) {
      await auditar(client, {
        empresaId, atorId: ator.id, alvoId: alvo.id, acao: ACAO_AUDITORIA.TOGGLE, ip, dispositivo, antes: { acesso: toggleId, ligado: antes }, depois: { acesso: toggleId, ligado: depois },
      });
    }
    return resumirToggles(completo).toggles.find((t) => t.id === toggleId);
  });
}

/**
 * Copiar permissões: a CONFIGURAÇÃO DE ACESSO de `origem` vira a de `destino`,
 * ambos já existentes na empresa da sessão, numa transação só. Copia o grupo
 * (quando ativo; nunca para MASTER) e, se o ator for MASTER, as camadas
 * individuais (substituindo as do destino). Nunca copia perfil, nome, CPF,
 * matrícula, e-mail, setor, horário, IP, senha ou identidade. MASTER não é
 * origem nem destino: autoridade própria, sem grupo nem camada individual.
 * O resultado diz o que foi copiado e o que ficou de fora (e por quê).
 */
async function copiar(pool, {
  empresaId, atorId, destinoId, origemId, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(destinoId, 'identificador de destino');
  exigirId(origemId, 'identificador de origem');
  if (destinoId === origemId) {
    throw HttpError.badRequest(...ERRO.MESMO);
  }
  return usuarioAdministracao.emTransacao(pool, async (client) => {
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [usuarioAdministracao.travaDaEmpresa(empresaId)]);
    const ator = await autoridade.exigirAutoridadeAdministrativa(
      client, empresaId, atorId, ...ERRO.NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.USUARIOS,
    );
    const destino = await carregarAlvo(client, empresaId, destinoId, { travar: true });
    usuarioAdministracao.exigirPerfilGerenciavel(ator, destino.perfil);
    const origem = await repo.buscarDadosParaEdicao(client, empresaId, origemId);
    if (origem === null) {
      throw HttpError.notFound(...ERRO.ORIGEM);
    }
    if (destino.perfil === PERFIL_MASTER || origem.perfil === PERFIL_MASTER) {
      throw HttpError.conflict(...ERRO.MASTER_FIXO);
    }

    let grupo = { copiado: false, motivo: null };
    const grupoOrigem = origem.grupoAcessoId === null ? null : await grupoAcessoRepo.buscarPorId(client, empresaId, origem.grupoAcessoId);
    if (grupoOrigem !== null && grupoOrigem.ativo !== true) {
      grupo = { copiado: false, motivo: 'GRUPO_INATIVO' };
    } else if (destino.grupoAcessoId !== origem.grupoAcessoId) {
      await repo.atualizarAdministrativo(client, empresaId, destino.id, { grupoAcessoId: origem.grupoAcessoId });
      grupo = { copiado: true, motivo: null };
    } else {
      grupo = { copiado: true, motivo: null };
    }
    const individual = await copiaAcesso.copiarAcessoIndividual(client, {
      empresaId, ator, origemId: origem.id, destinoId: destino.id, destinoPerfil: destino.perfil, destinoAtivo: destino.ativo, ip, dispositivo,
    });
    await auditar(client, {
      empresaId, atorId: ator.id, alvoId: destino.id, acao: ACAO_AUDITORIA.COPIA, ip, dispositivo,
      antes: { grupoAcessoId: destino.grupoAcessoId },
      depois: {
        origemId: origem.id, grupoCopiado: grupo.copiado, grupoAcessoId: grupo.copiado ? origem.grupoAcessoId : destino.grupoAcessoId,
        individual: individual.executado, recursos: individual.recursos, bloqueios: individual.bloqueios, autorizacoes: individual.autorizacoes, ignoradas: individual.ignoradas,
      },
    });
    return {
      origemId: origem.id,
      destinoId: destino.id,
      grupo,
      individual: {
        executado: individual.executado, motivo: individual.motivo, recursos: individual.recursos, bloqueios: individual.bloqueios, autorizacoes: individual.autorizacoes, ignoradas: individual.ignoradas,
      },
    };
  });
}

module.exports = {
  copiar, detalhar, detalharToggles, configurarToggle, configurarRecurso, configurarAcao, ESTADOS, OPERACOES, ACAO_AUDITORIA, ERRO, escrever, montar,
};
