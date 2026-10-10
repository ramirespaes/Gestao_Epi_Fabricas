'use strict';

const { HttpError } = require('../errors/HttpError');
const gheRepo = require('../repositories/grupo-homogeneo-exposicao.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { normalizarCodigoGhe } = require('../utils/codigo-ghe');

/**
 * Serviço de grupos homogêneos de exposição — GHE (Bloco 9, Etapa B).
 *
 * Mesmo desenho de material.service.js (Etapa A): `pool` por parâmetro,
 * BEGIN/COMMIT explícito com ROLLBACK em qualquer exceção, módulos chamados
 * por namespace, validação de entrada ANTES de abrir transação (fail fast),
 * auditoria na mesma transação da escrita, e NENHUMA decisão de
 * autorização aqui — quem decide é `criarExigirPermissaoRecurso(
 * 'employeeGroups', operacao)` montado nas rotas. `'employeeGroups'` é o
 * identificador definido no planejamento do Bloco 9 (seção 10.2): distinto
 * de `'employeeHistory'` (funcionários), para que administrar GHE e
 * administrar funcionários sejam autoridades independentes.
 *
 * SEM EXCLUSÃO FÍSICA: GHE é inativado. Inativar NÃO desvincula os
 * funcionários que o referenciam (funcionarios.grupo_homogeneo_id fica como
 * está — a FK composta da migration 006 só impede apagar, e apagar não
 * existe). O que muda é que um GHE inativo deixa de aceitar NOVOS vínculos
 * (regra de funcionario.service.js), mesma lógica de grupo inativo no RBAC.
 *
 * Nome único por empresa: `uq_ghe_empresa_nome` (migration 004) compara o
 * texto exato — "Manutenção" e "manutenção" são nomes distintos para o
 * banco. Este serviço não acrescenta unicidade sem diferenciar maiúsculas
 * (exigiria índice funcional, isto é, migration nova — fora do escopo).
 *
 * Código do GHE (migration 083): obrigatório em GHE NOVO, opcional no legado (NULL), nunca removível depois
 * de atribuído, mas corrigível; formato e normalização em utils/codigo-ghe.js. A unicidade por empresa é do
 * índice uq_ghe_empresa_codigo, que também serializa as corridas; a violação é traduzida pelo NOME da
 * constraint, e qualquer outro 23505 é relançado (nunca mascarado como conflito de nome ou de código).
 */

const VIOLACAO_UNIQUE = '23505';
const CONSTRAINT_NOME = 'uq_ghe_empresa_nome';
const CONSTRAINT_CODIGO = 'uq_ghe_empresa_codigo';

const ACAO_AUDITORIA_CRIACAO = 'GHE_CRIADO';
const ACAO_AUDITORIA_ALTERACAO = 'GHE_ALTERADO';
const ACAO_AUDITORIA_INATIVACAO = 'GHE_INATIVADO';
const ACAO_AUDITORIA_REATIVACAO = 'GHE_REATIVADO';

const MSG_NOME_INVALIDO = 'Nome de GHE inválido';
const MSG_NOME_EM_USO = 'Já existe um GHE com este nome nesta empresa';
const MSG_CODIGO_OBRIGATORIO = 'Informe o código do GHE';
const MSG_CODIGO_INVALIDO = 'Código de GHE inválido. Use GHE- seguido de 3 a 6 dígitos';
const MSG_CODIGO_EM_USO = 'Já existe um GHE com este código nesta empresa';
const MSG_NAO_ENCONTRADO = 'GHE não encontrado';
const MSG_SEM_ALTERACAO = 'Nenhum campo para alterar';
const MSG_DADOS_INVALIDOS = 'Dados de GHE inválidos';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function normalizarNome(nome) {
  if (typeof nome !== 'string') {
    return null;
  }
  const aparado = nome.trim();
  return aparado.length === 0 || aparado.length > gheRepo.TAMANHO_MAXIMO_NOME ? null : aparado;
}

/** Texto opcional: aparado; vazio vira null; acima do teto vira undefined (inválido). */
function normalizarTextoOpcional(valor, tamanhoMaximo = Infinity) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (typeof valor !== 'string') {
    throw new TypeError('campo de texto deve ser string ou null');
  }
  const aparado = valor.trim();
  if (aparado.length > tamanhoMaximo) {
    return undefined;
  }
  return aparado.length === 0 ? null : aparado;
}

/** Traduz a violação de unicidade pela constraint; qualquer outra é relançada como veio. */
function traduzirViolacao(erro) {
  if (erro.code === VIOLACAO_UNIQUE && erro.constraint === CONSTRAINT_CODIGO) {
    return HttpError.conflict('GHE_CODIGO_EM_USO', MSG_CODIGO_EM_USO);
  }
  if (erro.code === VIOLACAO_UNIQUE && erro.constraint === CONSTRAINT_NOME) {
    return HttpError.conflict('GHE_NOME_EM_USO', MSG_NOME_EM_USO);
  }
  return erro;
}

function exigirCodigoValido(codigo) {
  const canonico = normalizarCodigoGhe(codigo);
  if (canonico === null) {
    throw HttpError.badRequest('GHE_CODIGO_INVALIDO', MSG_CODIGO_INVALIDO);
  }
  return canonico;
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

const instantaneo = (ghe) => ({
  nome: ghe.nome, codigo: ghe.codigo, descricao: ghe.descricao, setor: ghe.setor, funcao: ghe.funcao, riscos: ghe.riscos, ativo: ghe.ativo,
});

async function criar(pool, {
  empresaId, atorId, nome, codigo, descricao = null, setor = null, funcao = null, riscos = null, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');

  const nomeNormalizado = normalizarNome(nome);
  const descricaoNormalizada = normalizarTextoOpcional(descricao);
  const setorNormalizado = normalizarTextoOpcional(setor, gheRepo.TAMANHO_MAXIMO_SETOR);
  const funcaoNormalizada = normalizarTextoOpcional(funcao, gheRepo.TAMANHO_MAXIMO_FUNCAO);
  const riscosNormalizados = normalizarTextoOpcional(riscos);

  if (nomeNormalizado === null) {
    throw HttpError.badRequest('GHE_NOME_INVALIDO', MSG_NOME_INVALIDO);
  }
  if (codigo === undefined) {
    throw HttpError.badRequest('GHE_CODIGO_OBRIGATORIO', MSG_CODIGO_OBRIGATORIO);
  }
  const codigoNormalizado = exigirCodigoValido(codigo);
  if ([descricaoNormalizada, setorNormalizado, funcaoNormalizada, riscosNormalizados].includes(undefined)) {
    throw HttpError.badRequest('GHE_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
  }

  return emTransacao(pool, async (client) => {
    let ghe;
    try {
      ghe = await gheRepo.criar(client, {
        empresaId, nome: nomeNormalizado, codigo: codigoNormalizado, descricao: descricaoNormalizada, setor: setorNormalizado, funcao: funcaoNormalizada, riscos: riscosNormalizados,
      });
    } catch (erro) {
      throw traduzirViolacao(erro);
    }

    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO_AUDITORIA_CRIACAO, referencia: String(ghe.id), ip, dispositivo,
      contexto: { criadoPor: atorId }, dadosNovos: instantaneo(ghe),
    });

    return ghe;
  });
}

async function buscar(pool, { empresaId, gheId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(gheId, 'identificador de GHE');

  const ghe = await gheRepo.buscarPorId(pool, empresaId, gheId);
  if (ghe === null) {
    throw HttpError.notFound('GHE_NAO_ENCONTRADO', MSG_NAO_ENCONTRADO);
  }
  return ghe;
}

async function listar(pool, { empresaId, ativo = null, busca = null, pagina = 1, limite = 20 }) {
  exigirId(empresaId, 'identificador de empresa');

  const [grupos, total] = await Promise.all([
    gheRepo.listarPorEmpresa(pool, empresaId, { ativo, busca, pagina, limite }),
    gheRepo.contarPorEmpresa(pool, empresaId, { ativo, busca }),
  ]);

  return { grupos, total, pagina, limite };
}

async function alterar(pool, {
  empresaId, atorId, gheId,
  nome, codigo, descricao, descricaoInformado = false, setor, setorInformado = false,
  funcao, funcaoInformado = false, riscos, riscosInformado = false,
  ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(gheId, 'identificador de GHE');

  const alterarNome = nome !== undefined;
  const nomeNormalizado = alterarNome ? normalizarNome(nome) : null;
  const alterarCodigo = codigo !== undefined;
  const descricaoNormalizada = descricaoInformado ? normalizarTextoOpcional(descricao) : null;
  const setorNormalizado = setorInformado ? normalizarTextoOpcional(setor, gheRepo.TAMANHO_MAXIMO_SETOR) : null;
  const funcaoNormalizada = funcaoInformado ? normalizarTextoOpcional(funcao, gheRepo.TAMANHO_MAXIMO_FUNCAO) : null;
  const riscosNormalizados = riscosInformado ? normalizarTextoOpcional(riscos) : null;

  if (!alterarNome && !alterarCodigo && !descricaoInformado && !setorInformado && !funcaoInformado && !riscosInformado) {
    throw HttpError.badRequest('GHE_SEM_ALTERACAO', MSG_SEM_ALTERACAO);
  }
  if (alterarNome && nomeNormalizado === null) {
    throw HttpError.badRequest('GHE_NOME_INVALIDO', MSG_NOME_INVALIDO);
  }
  // Código informado: sempre exige forma válida; nulo, vazio ou só espaços nunca passam (o código não se remove).
  const codigoNormalizado = alterarCodigo ? exigirCodigoValido(codigo) : null;
  if ([descricaoNormalizada, setorNormalizado, funcaoNormalizada, riscosNormalizados].includes(undefined)) {
    throw HttpError.badRequest('GHE_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
  }

  return emTransacao(pool, async (client) => {
    const anterior = await gheRepo.buscarPorIdParaAtualizacao(client, empresaId, gheId);
    if (anterior === null) {
      throw HttpError.notFound('GHE_NAO_ENCONTRADO', MSG_NAO_ENCONTRADO);
    }

    // Estado já travado (FOR UPDATE): o mesmo código, sozinho, não escreve nem audita.
    const mesmoCodigo = alterarCodigo && codigoNormalizado === anterior.codigo;
    if (mesmoCodigo && !alterarNome && !descricaoInformado && !setorInformado && !funcaoInformado && !riscosInformado) {
      return anterior;
    }

    let atualizado;
    try {
      atualizado = await gheRepo.atualizar(client, empresaId, gheId, {
        nome: nomeNormalizado,
        codigo: mesmoCodigo ? null : codigoNormalizado,
        descricao: descricaoNormalizada, descricaoInformado,
        setor: setorNormalizado, setorInformado,
        funcao: funcaoNormalizada, funcaoInformado,
        riscos: riscosNormalizados, riscosInformado,
      });
    } catch (erro) {
      throw traduzirViolacao(erro);
    }

    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO_AUDITORIA_ALTERACAO, referencia: String(gheId), ip, dispositivo,
      dadosAnteriores: instantaneo(anterior), dadosNovos: instantaneo(atualizado),
    });

    return atualizado;
  });
}

async function alterarEstado(pool, { empresaId, atorId, gheId, ativo, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(gheId, 'identificador de GHE');

  return emTransacao(pool, async (client) => {
    const anterior = await gheRepo.buscarPorIdParaAtualizacao(client, empresaId, gheId);
    if (anterior === null) {
      throw HttpError.notFound('GHE_NAO_ENCONTRADO', MSG_NAO_ENCONTRADO);
    }
    if (anterior.ativo === ativo) {
      return { grupo: anterior, alterado: false };
    }

    const atualizado = await gheRepo.atualizar(client, empresaId, gheId, { ativo });

    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ativo ? ACAO_AUDITORIA_REATIVACAO : ACAO_AUDITORIA_INATIVACAO,
      referencia: String(gheId), ip, dispositivo,
      contexto: { efeito: ativo ? 'GHE_VOLTA_A_ACEITAR_VINCULOS' : 'GHE_NAO_ACEITA_NOVOS_VINCULOS_VINCULOS_EXISTENTES_PRESERVADOS' },
      dadosAnteriores: instantaneo(anterior), dadosNovos: instantaneo(atualizado),
    });

    return { grupo: atualizado, alterado: true };
  });
}

async function inativar(pool, dados) {
  return alterarEstado(pool, { ...dados, ativo: false });
}

async function reativar(pool, dados) {
  return alterarEstado(pool, { ...dados, ativo: true });
}

// `instantaneo` também é usado pela confirmação da importação GHE/EPI: mesmo retrato do GHE na auditoria.
module.exports = { criar, buscar, listar, alterar, inativar, reativar, instantaneo };
