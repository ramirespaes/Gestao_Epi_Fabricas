'use strict';

const { HttpError } = require('../errors/HttpError');
const empresaRepo = require('../repositories/empresa.repository');
const auditoriaPlataformaRepo = require('../repositories/auditoria-plataforma.repository');
const provisionamento = require('./provisionamento-permissoes.service');
const { normalizarCnpj, cnpjTemDigitosVerificadoresValidos, normalizarEmail } = require('../utils/normalizacao');

/**
 * Cadastro centralizado de empresas contratantes pelo Painel Privado
 * (Pacote 3 — Autenticação Global, 23/09/2026).
 *
 * FONTE CENTRAL: a tabela `empresas` (001/016/032) é a única fonte dos
 * dados institucionais que os módulos operacionais (ficha de EPI,
 * relatórios, documentos) passarão a consumir — determinados pela sessão
 * empresarial autenticada, nunca por empresa_id enviado pelo navegador.
 * Este serviço não cria nenhuma segunda tabela nem cadastro paralelo.
 *
 * AUTORIDADE: `administradorId` vem SEMPRE do contexto de sessão do Painel
 * Privado (req.administradorPlataforma), preenchido pelo middleware
 * exigirSessaoPlataforma após validar o cookie administrativo — nunca do
 * corpo, da query ou de um cabeçalho. O administrador da plataforma NÃO
 * ganha, por cadastrar a empresa, nenhum acesso operacional a ela: nada
 * aqui escreve em `usuarios`, `sessoes` ou permissões DE USUÁRIO.
 *
 * PROVISIONAMENTO MASTER NA MESMA TRANSAÇÃO (item 5 da instrução; adendo
 * v2.1 §5 item 4): logo após o INSERT da empresa, e dentro da MESMA
 * transação, `provisionamento.provisionarComExecutor(client, ...)` cria as
 * permissões de PERFIL do MASTER no escopo já aprovado
 * (ESCOPO_PROVISIONAMENTO_MASTER, src/rbac/recursos.js) — o serviço do
 * Bloco 9 reutilizado por composição (extração de função, sem alterar o
 * comportamento nem os testes de `provisionar()`). Se o provisionamento
 * falhar, a empresa não fica criada "pela metade": ROLLBACK das duas
 * coisas. O resultado devolve `prontaParaMaster` — falso quando qualquer
 * item do escopo ficou INSUFICIENTE/NAO_CATALOGADA (o provisionamento
 * existente não sobrescreve linhas insuficientes; a inconsistência é
 * DETECTADA e INFORMADA, nunca escondida).
 *
 * CNPJ: alfanumérico canônico (016), com dígitos verificadores conferidos
 * pela aplicação (utils/normalizacao.js — fonte única); IMUTÁVEL após o
 * cadastro (mesma disciplina do CPF de funcionário): `alterar` recusa a
 * chave, o repositório não tem cláusula para a coluna. Duplicidade é a
 * UNIQUE uq_empresas_cnpj do banco, traduzida para 409.
 *
 * INSCRIÇÃO ESTADUAL: opcional. NUNCA preenchida automaticamente com
 * "ISENTO" — a situação (CONTRIBUINTE/ISENTO/NAO_CONTRIBUINTE) só existe
 * quando declarada. Única regra de coerência: CONTRIBUINTE exige o número.
 *
 * CONTATOS: representante, financeiro e institucional são colunas
 * separadas (finalidades distintas — migration 032). O e-mail do
 * representante NUNCA vira login MASTER: o primeiro MASTER só nasce pelo
 * convite (convite-master.service.js), explicitamente.
 *
 * AUDITORIA: logs_auditoria_plataforma (029/031) — trilha da PLATAFORMA,
 * com administrador_id de quem agiu e empresa_afetada_id. Instantâneos
 * com dados cadastrais (nenhum é credencial); nenhuma chave sensível.
 *
 * SEM EXCLUSÃO FÍSICA: inativar/reativar apenas.
 */

const VIOLACAO_UNIQUE = '23505';
const CONSTRAINT_CNPJ = 'uq_empresas_cnpj';

const ACAO = Object.freeze({
  CRIADA: 'EMPRESA_CRIADA',
  ALTERADA: 'EMPRESA_ALTERADA',
  INATIVADA: 'EMPRESA_INATIVADA',
  REATIVADA: 'EMPRESA_REATIVADA',
});

const SITUACOES_IE = Object.freeze(['CONTRIBUINTE', 'ISENTO', 'NAO_CONTRIBUINTE']);
const UF_FORMATO = /^[A-Z]{2}$/;
const CEP_FORMATO = /^[0-9]{5}-?[0-9]{3}$/;

const MSG = Object.freeze({
  RAZAO_SOCIAL: 'Razão social inválida',
  CNPJ: 'CNPJ inválido',
  CNPJ_DV: 'CNPJ com dígitos verificadores inválidos',
  CNPJ_EM_USO: 'Já existe uma empresa cadastrada com este CNPJ',
  CNPJ_IMUTAVEL: 'cnpj não pode ser alterado após o cadastro',
  DADOS: 'Dados cadastrais da empresa inválidos',
  IE_EXIGIDA: 'Situação CONTRIBUINTE exige o número da inscrição estadual',
  NAO_ENCONTRADA: 'Empresa não encontrada',
  SEM_ALTERACAO: 'Nenhum campo para alterar',
});

// Campos opcionais: [chave, tamanho máximo, normalizador]. Ordem irrelevante.
const CAMPOS_OPCIONAIS = empresaRepo.CAMPOS_OPCIONAIS.map(([chave, , tamanho]) => [chave, tamanho]);
const CAMPOS_EMAIL = new Set(['email', 'representanteEmail', 'financeiroEmail']);

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

function normalizarTexto(valor, tamanhoMaximo) {
  if (typeof valor !== 'string') {
    return null;
  }
  const aparado = valor.trim().normalize('NFC');
  return aparado.length === 0 || Array.from(aparado).length > tamanhoMaximo ? null : aparado;
}

/**
 * Normaliza um campo opcional pela sua natureza. Devolve `null` para
 * ausência/vazio, o valor canônico quando válido, e `undefined` quando
 * INVÁLIDO (o chamador transforma em 400).
 */
function normalizarOpcional(chave, valor, tamanhoMaximo) {
  if (valor === null || valor === undefined) {
    return null;
  }
  if (typeof valor !== 'string') {
    throw new TypeError(`${chave} deve ser string ou null`);
  }
  const aparado = valor.trim();
  if (aparado.length === 0) {
    return null;
  }
  if (CAMPOS_EMAIL.has(chave)) {
    return normalizarEmail(aparado) ?? undefined;
  }
  if (chave === 'uf') {
    const uf = aparado.toUpperCase();
    return UF_FORMATO.test(uf) ? uf : undefined;
  }
  if (chave === 'cep') {
    return CEP_FORMATO.test(aparado) ? aparado.replace('-', '') : undefined;
  }
  if (chave === 'situacaoInscricaoEstadual') {
    const situacao = aparado.toUpperCase();
    return SITUACOES_IE.includes(situacao) ? situacao : undefined;
  }
  const texto = aparado.normalize('NFC');
  return Array.from(texto).length > tamanhoMaximo ? undefined : texto;
}

/** CNPJ canônico com DV conferido, ou null. */
function normalizarCnpjValido(cnpj) {
  const normalizado = normalizarCnpj(cnpj);
  return normalizado !== null && cnpjTemDigitosVerificadoresValidos(normalizado) ? normalizado : null;
}

function exigirCoerenciaIe(dados) {
  if (dados.situacaoInscricaoEstadual === 'CONTRIBUINTE' && dados.inscricaoEstadual === null) {
    throw HttpError.badRequest('EMPRESA_IE_EXIGIDA', MSG.IE_EXIGIDA);
  }
}

function traduzirViolacao(erro) {
  if (erro.code === VIOLACAO_UNIQUE && erro.constraint === CONSTRAINT_CNPJ) {
    return HttpError.conflict('EMPRESA_CNPJ_EM_USO', MSG.CNPJ_EM_USO);
  }
  return erro;
}

/** Instantâneo para auditoria: dados cadastrais (nenhum é credencial). */
const instantaneo = (e) => ({
  razaoSocial: e.razaoSocial, nomeFantasia: e.nomeFantasia, cnpj: e.cnpj,
  inscricaoEstadual: e.inscricaoEstadual, situacaoInscricaoEstadual: e.situacaoInscricaoEstadual,
  endereco: e.endereco, numero: e.numero, complemento: e.complemento, bairro: e.bairro, cidade: e.cidade, uf: e.uf, cep: e.cep,
  telefone: e.telefone, email: e.email, representante: e.representante, financeiro: e.financeiro, ativo: e.ativo,
});

/**
 * Cria a empresa E provisiona as permissões do MASTER na mesma transação.
 *
 * @param {import('pg').Pool} pool
 * @returns {Promise<{empresa: object, provisionamento: {plano: object, inseridos: object, prontaParaMaster: boolean, auditoriaId: string|null}}>}
 */
async function criar(pool, { administradorId, razaoSocial, cnpj, ip = null, dispositivo = null, ...opcionais }) {
  exigirId(administradorId, 'identificador de administrador');

  const razaoSocialN = normalizarTexto(razaoSocial, empresaRepo.TAMANHOS.NOME);
  if (razaoSocialN === null) {
    throw HttpError.badRequest('EMPRESA_RAZAO_SOCIAL_INVALIDA', MSG.RAZAO_SOCIAL);
  }
  if (normalizarCnpj(cnpj) === null) {
    throw HttpError.badRequest('EMPRESA_CNPJ_INVALIDO', MSG.CNPJ);
  }
  const cnpjN = normalizarCnpjValido(cnpj);
  if (cnpjN === null) {
    throw HttpError.badRequest('EMPRESA_CNPJ_DV_INVALIDO', MSG.CNPJ_DV);
  }

  const campos = {};
  for (const [chave, tamanho] of CAMPOS_OPCIONAIS) {
    const valor = normalizarOpcional(chave, opcionais[chave], tamanho);
    if (valor === undefined) {
      throw HttpError.badRequest('EMPRESA_DADOS_INVALIDOS', MSG.DADOS);
    }
    campos[chave] = valor;
  }
  exigirCoerenciaIe(campos);

  return emTransacao(pool, async (client) => {
    let empresa;
    try {
      empresa = await empresaRepo.criar(client, { razaoSocial: razaoSocialN, cnpj: cnpjN, ...campos });
    } catch (erro) {
      throw traduzirViolacao(erro);
    }

    // Mesma transação: um erro aqui desfaz também o INSERT acima.
    const resultado = await provisionamento.provisionarComExecutor(client, {
      empresaId: empresa.id, atorId: null, ip, dispositivo,
    });
    const prontaParaMaster = provisionamento.prontaParaMaster(resultado.plano);

    await auditoriaPlataformaRepo.registrar(client, {
      administradorId, empresaAfetadaId: empresa.id, acao: ACAO.CRIADA, referencia: String(empresa.id), ip, dispositivo,
      contexto: {
        origem: 'painel_privado',
        provisionamentoMaster: { prontaParaMaster, totais: provisionamento.resumir(resultado.plano) },
      },
      dadosNovos: instantaneo(empresa),
    });

    return {
      empresa,
      provisionamento: { plano: resultado.plano, inseridos: resultado.inseridos, auditoriaId: resultado.auditoriaId, prontaParaMaster },
    };
  });
}

async function buscar(pool, { empresaId }) {
  exigirId(empresaId, 'identificador de empresa');
  const empresa = await empresaRepo.buscarDetalhesPorId(pool, empresaId);
  if (empresa === null) {
    throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', MSG.NAO_ENCONTRADA);
  }
  return empresa;
}

async function listar(pool, { ativo = null, busca = null, pagina = 1, limite = 20 }) {
  const [empresas, total] = await Promise.all([
    empresaRepo.listar(pool, { ativo, busca, pagina, limite }),
    empresaRepo.contar(pool, { ativo, busca }),
  ]);
  return { empresas, total, pagina, limite };
}

/**
 * Situação do provisionamento MASTER de uma empresa (somente leitura) —
 * responde "esta empresa está pronta para o MASTER operar?" a qualquer
 * momento, não só na criação.
 */
async function consultarProvisionamento(pool, { empresaId }) {
  exigirId(empresaId, 'identificador de empresa');
  let plano;
  try {
    plano = await provisionamento.planejar(pool, { empresaId });
  } catch (erro) {
    if (erro instanceof provisionamento.ErroProvisionamento) {
      if (erro.codigo === 'EMPRESA_NAO_ENCONTRADA') {
        throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', MSG.NAO_ENCONTRADA);
      }
      // EMPRESA_INATIVA: nada a provisionar; a tela mostra a situação.
      throw HttpError.conflict('EMPRESA_INATIVA', erro.message);
    }
    throw erro;
  }
  return { plano, totais: provisionamento.resumir(plano), prontaParaMaster: provisionamento.prontaParaMaster(plano) };
}

async function alterar(pool, dados) {
  if (Object.hasOwn(dados, 'cnpj')) {
    throw new TypeError(MSG.CNPJ_IMUTAVEL);
  }
  const { administradorId, empresaId, razaoSocial, ip = null, dispositivo = null } = dados;
  exigirId(administradorId, 'identificador de administrador');
  exigirId(empresaId, 'identificador de empresa');

  const alterarRazao = razaoSocial !== undefined;
  const razaoN = alterarRazao ? normalizarTexto(razaoSocial, empresaRepo.TAMANHOS.NOME) : null;
  if (alterarRazao && razaoN === null) {
    throw HttpError.badRequest('EMPRESA_RAZAO_SOCIAL_INVALIDA', MSG.RAZAO_SOCIAL);
  }

  const campos = {};
  let algumInformado = alterarRazao;
  for (const [chave, tamanho] of CAMPOS_OPCIONAIS) {
    const informado = dados[`${chave}Informado`] === true;
    if (!informado) {
      continue;
    }
    algumInformado = true;
    const valor = normalizarOpcional(chave, dados[chave], tamanho);
    if (valor === undefined) {
      throw HttpError.badRequest('EMPRESA_DADOS_INVALIDOS', MSG.DADOS);
    }
    campos[chave] = valor;
    campos[`${chave}Informado`] = true;
  }
  if (!algumInformado) {
    throw HttpError.badRequest('EMPRESA_SEM_ALTERACAO', MSG.SEM_ALTERACAO);
  }

  return emTransacao(pool, async (client) => {
    const anterior = await empresaRepo.buscarDetalhesPorIdParaAtualizacao(client, empresaId);
    if (anterior === null) {
      throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', MSG.NAO_ENCONTRADA);
    }
    // Coerência da IE avaliada sobre o estado RESULTANTE (o que muda + o que fica).
    exigirCoerenciaIe({
      situacaoInscricaoEstadual: campos.situacaoInscricaoEstadualInformado ? campos.situacaoInscricaoEstadual : anterior.situacaoInscricaoEstadual,
      inscricaoEstadual: campos.inscricaoEstadualInformado ? campos.inscricaoEstadual : anterior.inscricaoEstadual,
    });

    const atualizada = await empresaRepo.atualizar(client, empresaId, { ...(alterarRazao ? { razaoSocial: razaoN } : {}), ...campos });

    await auditoriaPlataformaRepo.registrar(client, {
      administradorId, empresaAfetadaId: empresaId, acao: ACAO.ALTERADA, referencia: String(empresaId), ip, dispositivo,
      contexto: { origem: 'painel_privado' },
      dadosAnteriores: instantaneo(anterior), dadosNovos: instantaneo(atualizada),
    });

    return atualizada;
  });
}

async function alterarEstado(pool, { administradorId, empresaId, ativo, ip = null, dispositivo = null }) {
  exigirId(administradorId, 'identificador de administrador');
  exigirId(empresaId, 'identificador de empresa');
  if (typeof ativo !== 'boolean') {
    throw new TypeError('ativo deve ser booleano');
  }

  return emTransacao(pool, async (client) => {
    const anterior = await empresaRepo.buscarDetalhesPorIdParaAtualizacao(client, empresaId);
    if (anterior === null) {
      throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', MSG.NAO_ENCONTRADA);
    }
    if (anterior.ativo === ativo) {
      return { empresa: anterior, alterado: false };
    }

    const atualizada = await empresaRepo.atualizarEstado(client, empresaId, ativo);

    await auditoriaPlataformaRepo.registrar(client, {
      administradorId, empresaAfetadaId: empresaId, acao: ativo ? ACAO.REATIVADA : ACAO.INATIVADA, referencia: String(empresaId), ip, dispositivo,
      contexto: { origem: 'painel_privado' },
      dadosAnteriores: { ativo: anterior.ativo }, dadosNovos: { ativo: atualizada.ativo },
    });

    return { empresa: atualizada, alterado: true };
  });
}

const inativar = (pool, dados) => alterarEstado(pool, { ...dados, ativo: false });
const reativar = (pool, dados) => alterarEstado(pool, { ...dados, ativo: true });

module.exports = { criar, buscar, listar, consultarProvisionamento, alterar, inativar, reativar, ACAO, SITUACOES_IE };
