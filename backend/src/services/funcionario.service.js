'use strict';

const { HttpError } = require('../errors/HttpError');
const funcionarioRepo = require('../repositories/funcionario.repository');
const gheRepo = require('../repositories/grupo-homogeneo-exposicao.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { normalizarCpf, cpfTemDigitosVerificadoresValidos } = require('../utils/normalizacao');

/**
 * Serviço de cadastro de funcionários (Bloco 9, Etapa B).
 *
 * FUNCIONÁRIO ≠ USUÁRIO: funcionário é quem RECEBE EPI (migration 006);
 * usuário é conta de acesso ao sistema (migration 005). Este serviço não
 * lê nem escreve `usuarios`, não cria conta para funcionário, não vincula
 * um ao outro — separação deliberada, confirmada no planejamento do Bloco 9
 * (seção 8.2) e pela ausência de qualquer FK entre as duas tabelas.
 *
 * Mesmo desenho de material.service.js: `pool` por parâmetro, transação
 * explícita, validação antes de abrir transação, auditoria na mesma
 * transação, nenhuma decisão de autorização (middleware de recurso
 * `'employeeHistory'`, nas rotas).
 *
 * CPF: normalizado e validado por dígitos verificadores com
 * utils/normalizacao.js (fonte única, CLAUDE.md §50); persistido só com os
 * 11 dígitos, como o CHECK da migration 006 exige. IMUTÁVEL após o
 * cadastro (decisão definitiva de 2026-09-23): `alterar` recebe o objeto
 * bruto e verifica `Object.hasOwn(dados, 'cpf')` ANTES de desestruturar —
 * não `cpf !== undefined` sobre o valor já desestruturado, que deixaria
 * passar uma chamada direta ao serviço com `cpf: undefined` explícito
 * (correção pós-auditoria independente de 23/09/2026: a API HTTP já
 * recusa `cpf` no schema de `alterar`, então esse caso não atravessa o
 * contrato HTTP; a correção é de consistência do contrato interno do
 * serviço, chamável diretamente). Qualquer presença da propriedade —
 * igual, diferente, `null` ou `undefined` — lança TypeError; não é
 * HttpError porque a recusa ao cliente já acontece no schema (400
 * CAMPO_NAO_PERMITIDO); aqui, receber `cpf` só pode ser erro de
 * programação. Não existe "corrigir CPF" nem transferência de histórico
 * entre cadastros: CPF errado se resolve inativando o funcionário e
 * cadastrando outro; a unicidade por empresa (uq_funcionarios_empresa_cpf)
 * continua valendo também para inativos.
 *
 * VÍNCULO A GHE: o banco já impede, pela FK composta
 * `fk_funcionarios_ghe_mesma_empresa`, vincular a GHE de outra empresa.
 * Este serviço acrescenta o que o banco não sabe: o GHE precisa existir
 * NESTA empresa (400, com mensagem de domínio em vez de violação de FK) e
 * estar ATIVO (409) — um GHE inativo não aceita novos vínculos, mas os
 * vínculos já existentes são preservados (regra espelhada de
 * grupo-homogeneo-exposicao.service.js).
 *
 * DADOS PESSOAIS NA AUDITORIA (CLAUDE.md §44): o instantâneo gravado em
 * logs_auditoria NÃO inclui cpf, data de nascimento nem telefone —
 * matrícula, nome, GHE, setor, função, crachá e estado bastam para
 * rastreabilidade. Quando um desses campos sensíveis muda, a auditoria
 * registra apenas QUE mudou (`camposSensiveisAlterados`), nunca o valor.
 */

const VIOLACAO_UNIQUE = '23505';
const VIOLACAO_FK = '23503';
const VIOLACAO_CHECK = '23514';
const CONSTRAINT_MATRICULA = 'uq_funcionarios_empresa_matricula';
const CONSTRAINT_CPF = 'uq_funcionarios_empresa_cpf';

const ACAO_AUDITORIA_CRIACAO = 'FUNCIONARIO_CRIADO';
const ACAO_AUDITORIA_ALTERACAO = 'FUNCIONARIO_ALTERADO';
const ACAO_AUDITORIA_INATIVACAO = 'FUNCIONARIO_INATIVADO';
const ACAO_AUDITORIA_REATIVACAO = 'FUNCIONARIO_REATIVADO';

const MSG_MATRICULA_INVALIDA = 'Matrícula inválida';
const MSG_NOME_INVALIDO = 'Nome de funcionário inválido';
const MSG_CPF_INVALIDO = 'CPF inválido';
const MSG_DADOS_INVALIDOS = 'Dados de funcionário inválidos';
const MSG_MATRICULA_EM_USO = 'Já existe um funcionário com esta matrícula nesta empresa';
const MSG_CPF_EM_USO = 'Já existe um funcionário com este CPF nesta empresa';
const MSG_NAO_ENCONTRADO = 'Funcionário não encontrado';
const MSG_GHE_INVALIDO = 'GHE inexistente nesta empresa';
const MSG_GHE_INATIVO = 'GHE inativo não aceita novos vínculos';
const MSG_SEM_ALTERACAO = 'Nenhum campo para alterar';

const CAMPOS_SENSIVEIS = ['cpf', 'dataNascimento', 'telefone'];
// Sensíveis que PODEM mudar por alterar(): cpf não está aqui de propósito.
const MSG_CPF_IMUTAVEL = 'cpf não pode ser alterado após o cadastro';

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) {
    throw new TypeError(`${nome} inválido`);
  }
}

function normalizarTexto(valor, tamanhoMaximo) {
  if (typeof valor !== 'string') {
    return null;
  }
  const aparado = valor.trim();
  return aparado.length === 0 || aparado.length > tamanhoMaximo ? null : aparado;
}

/** Texto opcional: aparado; vazio vira null; acima do teto vira undefined (inválido). */
function normalizarTextoOpcional(valor, tamanhoMaximo) {
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

/** CPF válido (estrutura + DV) normalizado para 11 dígitos, ou null. */
function normalizarCpfValido(cpf) {
  const normalizado = normalizarCpf(cpf);
  return normalizado !== null && cpfTemDigitosVerificadoresValidos(normalizado) ? normalizado : null;
}

function gheIdValido(valor) {
  return valor === null || valor === undefined || (Number.isInteger(valor) && valor > 0);
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

/** Instantâneo para auditoria — SEM cpf, dataNascimento e telefone. */
const instantaneo = (f) => ({
  matricula: f.matricula, nome: f.nome, grupoHomogeneoId: f.grupoHomogeneoId, setor: f.setor, funcao: f.funcao, cracha: f.cracha, ativo: f.ativo,
});

/**
 * GHE precisa existir nesta empresa e estar ativo para receber um vínculo
 * novo — e precisa CONTINUAR ativo até o COMMIT deste vínculo.
 *
 * Correção pós-auditoria da Etapa B (23/09/2026): a leitura era
 * `buscarPorId` (sem lock). Entre ela e o INSERT/UPDATE do vínculo, outra
 * transação podia inativar o GHE e commitar, e o vínculo era aceito a um
 * GHE já inativo — a FK composta garante existência e mesma empresa, nunca
 * `ativo`. Agora a leitura é `buscarPorIdParaVinculo` (FOR SHARE na linha
 * do GHE, dentro desta transação): a inativação concorrente (FOR UPDATE em
 * grupo-homogeneo-exposicao.service.alterarEstado) espera este COMMIT e,
 * ao inativar depois, PRESERVA o vínculo já confirmado; no sentido inverso,
 * se a inativação já está em curso, esta leitura espera o COMMIT dela e
 * relê o GHE já inativo → 409. Várias vinculações concorrentes ao mesmo GHE
 * continuam compatíveis entre si (share × share). Lock de UMA linha,
 * filtrada por empresa: outros GHEs e outras empresas não são afetados.
 *
 * Ordem de locks e deadlock: criar() trava só o GHE; alterar() trava o
 * funcionário (FOR UPDATE) e depois o GHE (FOR SHARE); a inativação trava
 * só o GHE e nunca toca funcionarios — não há ciclo possível.
 */
async function exigirGheVinculavel(client, empresaId, gheId) {
  const ghe = await gheRepo.buscarPorIdParaVinculo(client, empresaId, gheId);
  if (ghe === null) {
    throw HttpError.badRequest('FUNCIONARIO_GHE_INVALIDO', MSG_GHE_INVALIDO);
  }
  if (ghe.ativo !== true) {
    throw HttpError.conflict('FUNCIONARIO_GHE_INATIVO', MSG_GHE_INATIVO);
  }
}

function traduzirViolacao(erro) {
  if (erro.code === VIOLACAO_UNIQUE && erro.constraint === CONSTRAINT_MATRICULA) {
    return HttpError.conflict('FUNCIONARIO_MATRICULA_EM_USO', MSG_MATRICULA_EM_USO);
  }
  if (erro.code === VIOLACAO_UNIQUE && erro.constraint === CONSTRAINT_CPF) {
    return HttpError.conflict('FUNCIONARIO_CPF_EM_USO', MSG_CPF_EM_USO);
  }
  if (erro.code === VIOLACAO_FK) {
    return HttpError.badRequest('FUNCIONARIO_GHE_INVALIDO', MSG_GHE_INVALIDO);
  }
  if (erro.code === VIOLACAO_CHECK) {
    return HttpError.badRequest('FUNCIONARIO_CPF_INVALIDO', MSG_CPF_INVALIDO);
  }
  return erro;
}

async function criar(pool, {
  empresaId, atorId, matricula, nome, cpf, grupoHomogeneoId = null, dataNascimento = null,
  setor = null, funcao = null, cracha = null, telefone = null, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');

  const matriculaNormalizada = normalizarTexto(matricula, funcionarioRepo.TAMANHO_MAXIMO_MATRICULA);
  const nomeNormalizado = normalizarTexto(nome, funcionarioRepo.TAMANHO_MAXIMO_NOME);
  const cpfNormalizado = normalizarCpfValido(cpf);
  const setorN = normalizarTextoOpcional(setor, funcionarioRepo.TAMANHO_MAXIMO_SETOR);
  const funcaoN = normalizarTextoOpcional(funcao, funcionarioRepo.TAMANHO_MAXIMO_FUNCAO);
  const crachaN = normalizarTextoOpcional(cracha, funcionarioRepo.TAMANHO_MAXIMO_CRACHA);
  const telefoneN = normalizarTextoOpcional(telefone, funcionarioRepo.TAMANHO_MAXIMO_TELEFONE);

  if (matriculaNormalizada === null) {
    throw HttpError.badRequest('FUNCIONARIO_MATRICULA_INVALIDA', MSG_MATRICULA_INVALIDA);
  }
  if (nomeNormalizado === null) {
    throw HttpError.badRequest('FUNCIONARIO_NOME_INVALIDO', MSG_NOME_INVALIDO);
  }
  if (cpfNormalizado === null) {
    throw HttpError.badRequest('FUNCIONARIO_CPF_INVALIDO', MSG_CPF_INVALIDO);
  }
  if ([setorN, funcaoN, crachaN, telefoneN].includes(undefined) || !gheIdValido(grupoHomogeneoId)) {
    throw HttpError.badRequest('FUNCIONARIO_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
  }

  return emTransacao(pool, async (client) => {
    if (grupoHomogeneoId !== null) {
      await exigirGheVinculavel(client, empresaId, grupoHomogeneoId);
    }

    let funcionario;
    try {
      funcionario = await funcionarioRepo.criar(client, {
        empresaId, matricula: matriculaNormalizada, nome: nomeNormalizado, cpf: cpfNormalizado,
        grupoHomogeneoId, dataNascimento, setor: setorN, funcao: funcaoN, cracha: crachaN, telefone: telefoneN,
      });
    } catch (erro) {
      throw traduzirViolacao(erro);
    }

    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO_AUDITORIA_CRIACAO, referencia: String(funcionario.id), ip, dispositivo,
      contexto: { criadoPor: atorId, camposSensiveisOmitidos: CAMPOS_SENSIVEIS }, dadosNovos: instantaneo(funcionario),
    });

    return funcionario;
  });
}

async function buscar(pool, { empresaId, funcionarioId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');

  const funcionario = await funcionarioRepo.buscarPorId(pool, empresaId, funcionarioId);
  if (funcionario === null) {
    throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', MSG_NAO_ENCONTRADO);
  }
  return funcionario;
}

async function listar(pool, {
  empresaId, ativo = null, busca = null, grupoHomogeneoId = null, pagina = 1, limite = 20,
}) {
  exigirId(empresaId, 'identificador de empresa');

  const [funcionarios, total] = await Promise.all([
    funcionarioRepo.listarPorEmpresa(pool, empresaId, { ativo, busca, grupoHomogeneoId, pagina, limite }),
    funcionarioRepo.contarPorEmpresa(pool, empresaId, { ativo, busca, grupoHomogeneoId }),
  ]);

  return { funcionarios, total, pagina, limite };
}

async function alterar(pool, dados) {
  // Verificação sobre o OBJETO ORIGINAL, antes de qualquer desestruturação:
  // `Object.hasOwn` reconhece a propriedade mesmo quando seu valor é
  // `undefined` (`{ cpf: undefined }`), o que uma checagem sobre a variável
  // já desestruturada (`cpf !== undefined`) deixaria passar. CPF é imutável
  // após o cadastro — a presença da chave é recusada aqui, sempre, antes de
  // ler qualquer outro campo, abrir transação, consultar dados para
  // atualização ou registrar auditoria.
  if (Object.hasOwn(dados, 'cpf')) {
    throw new TypeError(MSG_CPF_IMUTAVEL);
  }

  const {
    empresaId, atorId, funcionarioId,
    matricula, nome,
    grupoHomogeneoId, grupoHomogeneoIdInformado = false,
    dataNascimento, dataNascimentoInformado = false,
    setor, setorInformado = false, funcao, funcaoInformado = false,
    cracha, crachaInformado = false, telefone, telefoneInformado = false,
    ip = null, dispositivo = null,
  } = dados;
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(funcionarioId, 'identificador de funcionário');

  const alterarMatricula = matricula !== undefined;
  const alterarNome = nome !== undefined;
  const matriculaN = alterarMatricula ? normalizarTexto(matricula, funcionarioRepo.TAMANHO_MAXIMO_MATRICULA) : null;
  const nomeN = alterarNome ? normalizarTexto(nome, funcionarioRepo.TAMANHO_MAXIMO_NOME) : null;
  const setorN = setorInformado ? normalizarTextoOpcional(setor, funcionarioRepo.TAMANHO_MAXIMO_SETOR) : null;
  const funcaoN = funcaoInformado ? normalizarTextoOpcional(funcao, funcionarioRepo.TAMANHO_MAXIMO_FUNCAO) : null;
  const crachaN = crachaInformado ? normalizarTextoOpcional(cracha, funcionarioRepo.TAMANHO_MAXIMO_CRACHA) : null;
  const telefoneN = telefoneInformado ? normalizarTextoOpcional(telefone, funcionarioRepo.TAMANHO_MAXIMO_TELEFONE) : null;
  const gheN = grupoHomogeneoIdInformado ? (grupoHomogeneoId ?? null) : null;

  const nenhumCampo = !alterarMatricula && !alterarNome && !grupoHomogeneoIdInformado
    && !dataNascimentoInformado && !setorInformado && !funcaoInformado && !crachaInformado && !telefoneInformado;
  if (nenhumCampo) {
    throw HttpError.badRequest('FUNCIONARIO_SEM_ALTERACAO', MSG_SEM_ALTERACAO);
  }
  if (alterarMatricula && matriculaN === null) {
    throw HttpError.badRequest('FUNCIONARIO_MATRICULA_INVALIDA', MSG_MATRICULA_INVALIDA);
  }
  if (alterarNome && nomeN === null) {
    throw HttpError.badRequest('FUNCIONARIO_NOME_INVALIDO', MSG_NOME_INVALIDO);
  }
  if ([setorN, funcaoN, crachaN, telefoneN].includes(undefined) || (grupoHomogeneoIdInformado && !gheIdValido(gheN))) {
    throw HttpError.badRequest('FUNCIONARIO_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
  }

  return emTransacao(pool, async (client) => {
    const anterior = await funcionarioRepo.buscarPorIdParaAtualizacao(client, empresaId, funcionarioId);
    if (anterior === null) {
      throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', MSG_NAO_ENCONTRADO);
    }
    if (grupoHomogeneoIdInformado && gheN !== null && gheN !== anterior.grupoHomogeneoId) {
      await exigirGheVinculavel(client, empresaId, gheN);
    }

    let atualizado;
    try {
      atualizado = await funcionarioRepo.atualizar(client, empresaId, funcionarioId, {
        matricula: matriculaN, nome: nomeN,
        grupoHomogeneoId: gheN, grupoHomogeneoIdInformado,
        dataNascimento: dataNascimentoInformado ? (dataNascimento ?? null) : null, dataNascimentoInformado,
        setor: setorN, setorInformado, funcao: funcaoN, funcaoInformado,
        cracha: crachaN, crachaInformado, telefone: telefoneN, telefoneInformado,
      });
    } catch (erro) {
      throw traduzirViolacao(erro);
    }

    const camposSensiveisAlterados = [
      ...(dataNascimentoInformado ? ['dataNascimento'] : []),
      ...(telefoneInformado ? ['telefone'] : []),
    ];

    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO_AUDITORIA_ALTERACAO, referencia: String(funcionarioId), ip, dispositivo,
      contexto: { camposSensiveisAlterados, camposSensiveisOmitidos: CAMPOS_SENSIVEIS },
      dadosAnteriores: instantaneo(anterior), dadosNovos: instantaneo(atualizado),
    });

    return atualizado;
  });
}

async function alterarEstado(pool, { empresaId, atorId, funcionarioId, ativo, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(funcionarioId, 'identificador de funcionário');

  return emTransacao(pool, async (client) => {
    const anterior = await funcionarioRepo.buscarPorIdParaAtualizacao(client, empresaId, funcionarioId);
    if (anterior === null) {
      throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', MSG_NAO_ENCONTRADO);
    }
    if (anterior.ativo === ativo) {
      return { funcionario: anterior, alterado: false };
    }

    const atualizado = await funcionarioRepo.atualizar(client, empresaId, funcionarioId, { ativo });

    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ativo ? ACAO_AUDITORIA_REATIVACAO : ACAO_AUDITORIA_INATIVACAO,
      referencia: String(funcionarioId), ip, dispositivo,
      contexto: { camposSensiveisOmitidos: CAMPOS_SENSIVEIS },
      dadosAnteriores: instantaneo(anterior), dadosNovos: instantaneo(atualizado),
    });

    return { funcionario: atualizado, alterado: true };
  });
}

async function inativar(pool, dados) {
  return alterarEstado(pool, { ...dados, ativo: false });
}

async function reativar(pool, dados) {
  return alterarEstado(pool, { ...dados, ativo: true });
}

module.exports = { criar, buscar, listar, alterar, inativar, reativar };
