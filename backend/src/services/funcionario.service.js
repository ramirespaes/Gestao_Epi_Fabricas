'use strict';

const { HttpError } = require('../errors/HttpError');
const funcionarioRepo = require('../repositories/funcionario.repository');
const gheRepo = require('../repositories/grupo-homogeneo-exposicao.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { normalizarCpf, cpfTemDigitosVerificadoresValidos, normalizarNomeGhe } = require('../utils/normalizacao');
const { TRANSICOES, situacaoDe } = require('../utils/situacao-funcionario');
const { dataOperacional } = require('../utils/data-operacional');
const { linhaImportacao, LINHAS_POR_LOTE } = require('../schemas/funcionario.schema');
const declaracaoLgpd = require('./declaracao-lgpd');

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
const ACAO_AUDITORIA_SITUACAO = 'FUNCIONARIO_SITUACAO_ALTERADA';
const ACAO_AUDITORIA_GHE = 'FUNCIONARIO_GHE_ALTERADO';
const ACAO_AUDITORIA_CPF_CONSULTADO = 'FUNCIONARIO_CPF_CONSULTADO';
const ORIGEM_AUDITORIA_SITUACAO = 'GESTAO_FUNCIONARIOS';

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
const MSG_GHE_OBRIGATORIO = 'O funcionário já tem GHE: informe outro GHE ativo para trocá-lo; o vínculo não pode ser removido';

const CAMPOS_SENSIVEIS = ['cpf', 'dataNascimento', 'telefone'];

// C4 (migration 040): admissão a partir de 1900 e sempre depois do
// nascimento, quando os dois existem. Datas chegam como AAAA-MM-DD (schema
// e repositório), então a comparação de texto é a comparação de calendário.
const ADMISSAO_MINIMA = '1900-01-01';
const MSG_DATA_ADMISSAO_INVALIDA = 'Data de admissão inválida: deve ser a partir de 1900 e posterior ao nascimento';
const CONSTRAINTS_ADMISSAO = ['chk_funcionarios_data_admissao_minima', 'chk_funcionarios_admissao_apos_nascimento'];
const CONSTRAINT_CPF_FORMATO = 'chk_funcionarios_cpf_formato';

// Importação em lote (C4, D1/D4).
const ACAO_AUDITORIA_IMPORTACAO_LOTE = 'FUNCIONARIOS_IMPORTACAO_LOTE';
const MSG_DECLARACAO_INVALIDA = 'A declaração sobre o tratamento dos dados precisa ser confirmada na versão vigente';

function datasValidas(dataNascimento, dataAdmissao) {
  if (dataAdmissao === null || dataAdmissao === undefined) {
    return true;
  }
  if (dataAdmissao < ADMISSAO_MINIMA) {
    return false;
  }
  return dataNascimento === null || dataNascimento === undefined || dataAdmissao > dataNascimento;
}

function exigirDatasValidas(dataNascimento, dataAdmissao) {
  if (!datasValidas(dataNascimento, dataAdmissao)) {
    throw HttpError.badRequest('FUNCIONARIO_DATA_ADMISSAO_INVALIDA', MSG_DATA_ADMISSAO_INVALIDA);
  }
}

// S4: regras de domínio das datas informadas, pela DATA CIVIL (`hoje` = dataOperacional do relógio injetado, em
// America/Sao_Paulo; AAAA-MM-DD compara como calendário). O formato e a existência no calendário já foram do schema.
// Só no cadastro individual e na edição: a importação em lote mantém o contrato congelado e não passa por aqui.
const NASCIMENTO_MINIMO = '1900-01-01';
const MSG_DATA_NASCIMENTO_INVALIDA = 'Data de nascimento inválida: deve ser a partir de 1900-01-01 e anterior a hoje';
const MSG_DATA_ADMISSAO_FUTURA = 'Data de admissão inválida: não pode ser futura';

function exigirNascimentoNoDominio(dataNascimento, hoje) {
  if (dataNascimento !== null && dataNascimento !== undefined && (dataNascimento < NASCIMENTO_MINIMO || dataNascimento >= hoje)) {
    throw HttpError.badRequest('FUNCIONARIO_DATA_NASCIMENTO_INVALIDA', MSG_DATA_NASCIMENTO_INVALIDA);
  }
}

function exigirAdmissaoNaoFutura(dataAdmissao, hoje) {
  if (dataAdmissao !== null && dataAdmissao !== undefined && dataAdmissao > hoje) {
    throw HttpError.badRequest('FUNCIONARIO_DATA_ADMISSAO_INVALIDA', MSG_DATA_ADMISSAO_FUTURA);
  }
}
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

/**
 * GHE atual nas respostas (S3): `grupoHomogeneo: { id, codigo, descricao } | null`, ao lado do `grupoHomogeneoId`. Uma
 * consulta só por chamada; o GHE inativado continua aparecendo (o vínculo existente não é apagado nem escondido).
 */
const resumoDoGhe = (resumos, gheId) => (gheId === null ? null : (resumos.get(gheId) ?? null));

async function anexarGhe(executor, empresaId, funcionarios) {
  const ids = [...new Set(funcionarios.map((f) => f.grupoHomogeneoId).filter((id) => id !== null))];
  const resumos = await gheRepo.resumirPorIds(executor, empresaId, ids);
  return funcionarios.map((f) => ({ ...f, grupoHomogeneo: resumoDoGhe(resumos, f.grupoHomogeneoId) }));
}

/** Instantâneo para auditoria — SEM cpf, dataNascimento e telefone (admissão é dado de vínculo, C4). */
const instantaneo = (f) => ({
  matricula: f.matricula, nome: f.nome, grupoHomogeneoId: f.grupoHomogeneoId, setor: f.setor, funcao: f.funcao, cracha: f.cracha,
  dataAdmissao: f.dataAdmissao ?? null, ativo: f.ativo,
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
  // CHECKs distinguidos pela constraint (C4: além do formato do CPF, as
  // duas barreiras da data de admissão da migration 040).
  if (erro.code === VIOLACAO_CHECK && CONSTRAINTS_ADMISSAO.includes(erro.constraint)) {
    return HttpError.badRequest('FUNCIONARIO_DATA_ADMISSAO_INVALIDA', MSG_DATA_ADMISSAO_INVALIDA);
  }
  if (erro.code === VIOLACAO_CHECK && erro.constraint === CONSTRAINT_CPF_FORMATO) {
    return HttpError.badRequest('FUNCIONARIO_CPF_INVALIDO', MSG_CPF_INVALIDO);
  }
  if (erro.code === VIOLACAO_CHECK) {
    return HttpError.badRequest('FUNCIONARIO_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
  }
  return erro;
}

/**
 * Normaliza e valida os dados de um cadastro novo, SEM abrir transação.
 * Lança HttpError 400 com o código do primeiro problema encontrado.
 * Compartilhado por criar() e importar() — as regras do cadastro
 * individual valem igualmente para cada linha importada (decisão D1).
 */
function prepararCadastro({
  matricula, nome, cpf, grupoHomogeneoId = null, dataNascimento = null,
  setor = null, funcao = null, cracha = null, telefone = null, dataAdmissao = null,
}) {
  // Matrícula opcional: null/ausente = sem matrícula; informada, precisa ser válida (vazia nunca vira NULL).
  const matriculaNormalizada = matricula === null || matricula === undefined ? null : normalizarTexto(matricula, funcionarioRepo.TAMANHO_MAXIMO_MATRICULA);
  const nomeNormalizado = normalizarTexto(nome, funcionarioRepo.TAMANHO_MAXIMO_NOME);
  const cpfNormalizado = normalizarCpfValido(cpf);
  const setorN = normalizarTextoOpcional(setor, funcionarioRepo.TAMANHO_MAXIMO_SETOR);
  const funcaoN = normalizarTextoOpcional(funcao, funcionarioRepo.TAMANHO_MAXIMO_FUNCAO);
  const crachaN = normalizarTextoOpcional(cracha, funcionarioRepo.TAMANHO_MAXIMO_CRACHA);
  const telefoneN = normalizarTextoOpcional(telefone, funcionarioRepo.TAMANHO_MAXIMO_TELEFONE);

  if (matriculaNormalizada === null && matricula !== null && matricula !== undefined) {
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
  exigirDatasValidas(dataNascimento, dataAdmissao);

  return {
    matricula: matriculaNormalizada, nome: nomeNormalizado, cpf: cpfNormalizado, grupoHomogeneoId,
    dataNascimento, setor: setorN, funcao: funcaoN, cracha: crachaN, telefone: telefoneN, dataAdmissao,
  };
}

/** Grava um cadastro já preparado e sua auditoria, na transação do chamador. */
async function gravarCadastro(client, { empresaId, atorId, ip, dispositivo, dados, contextoAuditoria = {} }) {
  if (dados.grupoHomogeneoId !== null) {
    await exigirGheVinculavel(client, empresaId, dados.grupoHomogeneoId);
  }

  let funcionario;
  try {
    funcionario = await funcionarioRepo.criar(client, { empresaId, ...dados });
  } catch (erro) {
    throw traduzirViolacao(erro);
  }

  await auditoriaRepo.registrar(client, {
    empresaId, usuarioId: atorId, acao: ACAO_AUDITORIA_CRIACAO, referencia: String(funcionario.id), ip, dispositivo,
    contexto: { criadoPor: atorId, camposSensiveisOmitidos: CAMPOS_SENSIVEIS, ...contextoAuditoria },
    dadosNovos: instantaneo(funcionario),
  });

  return funcionario;
}

async function criar(pool, {
  empresaId, atorId, ip = null, dispositivo = null, hoje = dataOperacional(), ...campos
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');

  // Nascimento fora do domínio primeiro (precedência do S4); a relação com a admissão é de prepararCadastro.
  exigirNascimentoNoDominio(campos.dataNascimento, hoje);
  const dados = prepararCadastro(campos);
  exigirAdmissaoNaoFutura(dados.dataAdmissao, hoje);

  return emTransacao(pool, async (client) => {
    const criado = await gravarCadastro(client, { empresaId, atorId, ip, dispositivo, dados });
    return (await anexarGhe(client, empresaId, [criado]))[0];
  });
}

async function buscar(pool, { empresaId, funcionarioId }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(funcionarioId, 'identificador de funcionário');

  const funcionario = await funcionarioRepo.buscarPorId(pool, empresaId, funcionarioId);
  if (funcionario === null) {
    throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', MSG_NAO_ENCONTRADO);
  }
  return (await anexarGhe(pool, empresaId, [funcionario]))[0];
}

/**
 * Revelação do CPF completo para a edição (única rota que o devolve). O funcionário é achado só pela empresa da sessão
 * (outra empresa e inexistente são o mesmo 404) e a auditoria — só metadados, nunca o CPF — é gravada na MESMA transação:
 * se ela falhar, nada é devolvido.
 */
async function revelarCpf(pool, {
  empresaId, atorId, funcionarioId, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(funcionarioId, 'identificador de funcionário');
  return emTransacao(pool, async (client) => {
    const funcionario = await funcionarioRepo.buscarPorId(client, empresaId, funcionarioId);
    if (funcionario === null) {
      throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', MSG_NAO_ENCONTRADO);
    }
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: ACAO_AUDITORIA_CPF_CONSULTADO, referencia: String(funcionario.id), ip, dispositivo,
      contexto: { finalidade: 'EDICAO' },
    });
    return { cpf: funcionario.cpf };
  });
}

async function listar(pool, {
  empresaId, ativo = null, busca = null, grupoHomogeneoId = null, cpf = null, pagina = 1, limite = 20,
}) {
  exigirId(empresaId, 'identificador de empresa');

  // `cpf` chega completo e normalizado do schema; igualdade exata no repositório.
  const [funcionarios, total] = await Promise.all([
    funcionarioRepo.listarPorEmpresa(pool, empresaId, { ativo, busca, grupoHomogeneoId, cpf, pagina, limite }),
    funcionarioRepo.contarPorEmpresa(pool, empresaId, { ativo, busca, grupoHomogeneoId, cpf }),
  ]);

  return { funcionarios: await anexarGhe(pool, empresaId, funcionarios), total, pagina, limite };
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
    dataAdmissao, dataAdmissaoInformado = false,
    ip = null, dispositivo = null, hoje = dataOperacional(),
  } = dados;
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(funcionarioId, 'identificador de funcionário');

  const alterarMatricula = matricula !== undefined;
  const alterarNome = nome !== undefined;
  const matriculaN = alterarMatricula && matricula !== null ? normalizarTexto(matricula, funcionarioRepo.TAMANHO_MAXIMO_MATRICULA) : null;
  const nomeN = alterarNome ? normalizarTexto(nome, funcionarioRepo.TAMANHO_MAXIMO_NOME) : null;
  const setorN = setorInformado ? normalizarTextoOpcional(setor, funcionarioRepo.TAMANHO_MAXIMO_SETOR) : null;
  const funcaoN = funcaoInformado ? normalizarTextoOpcional(funcao, funcionarioRepo.TAMANHO_MAXIMO_FUNCAO) : null;
  const crachaN = crachaInformado ? normalizarTextoOpcional(cracha, funcionarioRepo.TAMANHO_MAXIMO_CRACHA) : null;
  const telefoneN = telefoneInformado ? normalizarTextoOpcional(telefone, funcionarioRepo.TAMANHO_MAXIMO_TELEFONE) : null;
  const gheN = grupoHomogeneoIdInformado ? (grupoHomogeneoId ?? null) : null;

  const nenhumCampo = !alterarMatricula && !alterarNome && !grupoHomogeneoIdInformado
    && !dataNascimentoInformado && !setorInformado && !funcaoInformado && !crachaInformado && !telefoneInformado
    && !dataAdmissaoInformado;
  if (nenhumCampo) {
    throw HttpError.badRequest('FUNCIONARIO_SEM_ALTERACAO', MSG_SEM_ALTERACAO);
  }
  if (alterarMatricula && matricula !== null && matriculaN === null) {
    throw HttpError.badRequest('FUNCIONARIO_MATRICULA_INVALIDA', MSG_MATRICULA_INVALIDA);
  }
  if (alterarNome && nomeN === null) {
    throw HttpError.badRequest('FUNCIONARIO_NOME_INVALIDO', MSG_NOME_INVALIDO);
  }
  if ([setorN, funcaoN, crachaN, telefoneN].includes(undefined) || (grupoHomogeneoIdInformado && !gheIdValido(gheN))) {
    throw HttpError.badRequest('FUNCIONARIO_DADOS_INVALIDOS', MSG_DADOS_INVALIDOS);
  }

  // S4: as datas ENVIADAS passam pelo domínio (a relação entre elas e com as gravadas é checada adiante, sobre o estado final).
  if (dataNascimentoInformado) exigirNascimentoNoDominio(dataNascimento, hoje);
  if (dataAdmissaoInformado) exigirAdmissaoNaoFutura(dataAdmissao, hoje);

  return emTransacao(pool, async (client) => {
    const anterior = await funcionarioRepo.buscarPorIdParaAtualizacao(client, empresaId, funcionarioId);
    if (anterior === null) {
      throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', MSG_NAO_ENCONTRADO);
    }
    // S4: quem já tem GHE não fica sem (o legado sem GHE continua válido: null → null passa). Nada foi escrito até aqui.
    if (grupoHomogeneoIdInformado && gheN === null && anterior.grupoHomogeneoId !== null) {
      throw HttpError.badRequest('FUNCIONARIO_GHE_OBRIGATORIO', MSG_GHE_OBRIGATORIO);
    }
    if (grupoHomogeneoIdInformado && gheN !== null && gheN !== anterior.grupoHomogeneoId) {
      await exigirGheVinculavel(client, empresaId, gheN);
    }
    // Datas efetivas depois da alteração: o campo informado vale; o omitido
    // continua o gravado (lido travado acima). Ex.: nascimento novo posterior
    // a uma admissão já gravada também é recusado.
    exigirDatasValidas(
      dataNascimentoInformado ? (dataNascimento ?? null) : (anterior.dataNascimento ?? null),
      dataAdmissaoInformado ? (dataAdmissao ?? null) : (anterior.dataAdmissao ?? null),
    );

    let atualizado;
    try {
      atualizado = await funcionarioRepo.atualizar(client, empresaId, funcionarioId, {
        matricula: matriculaN, matriculaInformada: alterarMatricula, nome: nomeN,
        grupoHomogeneoId: gheN, grupoHomogeneoIdInformado,
        dataNascimento: dataNascimentoInformado ? (dataNascimento ?? null) : null, dataNascimentoInformado,
        setor: setorN, setorInformado, funcao: funcaoN, funcaoInformado,
        cracha: crachaN, crachaInformado, telefone: telefoneN, telefoneInformado,
        dataAdmissao: dataAdmissaoInformado ? (dataAdmissao ?? null) : null, dataAdmissaoInformado,
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

    // S3: troca REAL de GHE (inclui atribuir a quem não tinha e, no contrato atual, desvincular) tem evento próprio, na mesma
    // transação. O mesmo GHE, ou um PATCH sem GHE, não gera nada. Só id, código e descrição do GHE: nunca dado pessoal.
    const [comGhe] = await anexarGhe(client, empresaId, [atualizado]);
    if (atualizado.grupoHomogeneoId !== anterior.grupoHomogeneoId) {
      const resumos = await gheRepo.resumirPorIds(client, empresaId, [anterior.grupoHomogeneoId].filter((id) => id !== null));
      await auditoriaRepo.registrar(client, {
        empresaId, usuarioId: atorId, acao: ACAO_AUDITORIA_GHE, referencia: String(funcionarioId), ip, dispositivo,
        contexto: { origem: ORIGEM_AUDITORIA_SITUACAO },
        dadosAnteriores: { grupoHomogeneo: resumoDoGhe(resumos, anterior.grupoHomogeneoId) },
        dadosNovos: { grupoHomogeneo: comGhe.grupoHomogeneo },
      });
    }

    return comGhe;
  });
}

/**
 * Muda a situação (ATIVO, AFASTADO, INATIVO) sobre a linha TRAVADA (FOR UPDATE): a transição é validada contra o estado
 * já confirmado por quem veio antes, então duas mudanças concorrentes se ordenam e a cadeia anterior→nova da auditoria
 * não quebra. A auditoria vai na mesma transação (falhou, desfaz a mudança).
 *
 * `tolerarIgual` é o contrato das rotas legadas (inativar/reativar CONVERGEM para um alvo e são idempotentes); a rota
 * nova (S2) recusa a mesma situação (409 FUNCIONARIO_SITUACAO_IGUAL) e a transição proibida (409
 * FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA, ex.: INATIVO → AFASTADO). Os eventos legados FUNCIONARIO_INATIVADO e
 * FUNCIONARIO_REATIVADO só acompanham ATIVO → INATIVO e INATIVO → ATIVO; transição com AFASTADO grava só
 * FUNCIONARIO_SITUACAO_ALTERADA. Nenhum dos eventos leva CPF, telefone nem nascimento.
 */
async function mudarSituacao(client, { empresaId, atorId, funcionarioId, situacao, tolerarIgual, ip, dispositivo }) {
  const anterior = await funcionarioRepo.buscarPorIdParaAtualizacao(client, empresaId, funcionarioId);
  if (anterior === null) {
    throw HttpError.notFound('FUNCIONARIO_NAO_ENCONTRADO', MSG_NAO_ENCONTRADO);
  }
  const situacaoAnterior = situacaoDe(anterior);
  if (situacaoAnterior === situacao) {
    if (tolerarIgual) return { funcionario: anterior, situacaoAnterior, alterado: false };
    throw HttpError.conflict('FUNCIONARIO_SITUACAO_IGUAL', `O funcionário já está na situação ${situacao}`);
  }
  if (!TRANSICOES[situacaoAnterior].includes(situacao)) {
    throw HttpError.conflict('FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA', `Não é possível passar da situação ${situacaoAnterior} para ${situacao}`);
  }

  const atualizado = await funcionarioRepo.atualizar(client, empresaId, funcionarioId, { situacao });

  await auditoriaRepo.registrar(client, {
    empresaId, usuarioId: atorId, acao: ACAO_AUDITORIA_SITUACAO, referencia: String(funcionarioId), ip, dispositivo,
    contexto: { origem: ORIGEM_AUDITORIA_SITUACAO },
    dadosAnteriores: { situacao: situacaoAnterior }, dadosNovos: { situacao },
  });
  const legado = { ATIVO: { INATIVO: ACAO_AUDITORIA_INATIVACAO }, INATIVO: { ATIVO: ACAO_AUDITORIA_REATIVACAO } }[situacaoAnterior]?.[situacao];
  if (legado !== undefined) {
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: atorId, acao: legado, referencia: String(funcionarioId), ip, dispositivo,
      contexto: { camposSensiveisOmitidos: CAMPOS_SENSIVEIS },
      dadosAnteriores: instantaneo(anterior), dadosNovos: instantaneo(atualizado),
    });
  }

  return { funcionario: atualizado, situacaoAnterior, alterado: true };
}

async function alterarSituacao(pool, {
  empresaId, atorId, funcionarioId, situacao, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(funcionarioId, 'identificador de funcionário');
  return emTransacao(pool, (client) => mudarSituacao(client, {
    empresaId, atorId, funcionarioId, situacao, tolerarIgual: false, ip, dispositivo,
  }));
}

async function alterarEstado(pool, { empresaId, atorId, funcionarioId, ativo, ip = null, dispositivo = null }) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  exigirId(funcionarioId, 'identificador de funcionário');
  return emTransacao(pool, (client) => mudarSituacao(client, {
    empresaId, atorId, funcionarioId, situacao: ativo ? 'ATIVO' : 'INATIVO', tolerarIgual: true, ip, dispositivo,
  }));
}

async function inativar(pool, dados) {
  return alterarEstado(pool, { ...dados, ativo: false });
}

async function reativar(pool, dados) {
  return alterarEstado(pool, { ...dados, ativo: true });
}

// ═══════════════════════════════════════════════════════════════════
// Importação em lote (Bloco 9, Etapa C, Parte C4 — D1 e D4, 25/09/2026)
// ═══════════════════════════════════════════════════════════════════

// Motivo público por código: curto, sem ecoar o valor recebido.
const MOTIVOS = {
  FUNCIONARIO_NOME_INVALIDO: 'Nome inválido.',
  FUNCIONARIO_CPF_INVALIDO: 'CPF inválido.',
  FUNCIONARIO_MATRICULA_INVALIDA: 'Matrícula inválida.',
  FUNCIONARIO_DATA_ADMISSAO_INVALIDA: 'Data de admissão inválida: deve ser a partir de 1900 e posterior ao nascimento.',
  FUNCIONARIO_DATA_NASCIMENTO_INVALIDA: 'Data de nascimento inválida.',
  FUNCIONARIO_DADOS_INVALIDOS: 'Dados inválidos.',
  FUNCIONARIO_CPF_EM_USO: 'CPF já cadastrado nesta empresa.',
  FUNCIONARIO_MATRICULA_EM_USO: 'Matrícula já cadastrada para outro funcionário nesta empresa.',
  FUNCIONARIO_SITUACAO_NAO_INFORMADA: 'Situação não informada.',
  FUNCIONARIO_SITUACAO_NAO_RECONHECIDA: 'Situação não reconhecida: a importação aceita somente Ativo.',
  FUNCIONARIO_GHE_NAO_INFORMADO: 'GHE não informado: preencha a coluna GHE com o nome exato de um GHE cadastrado nesta empresa.',
  FUNCIONARIO_GHE_INEXISTENTE: 'GHE não encontrado nesta empresa: informe o nome de um GHE já cadastrado ou escolha um na prévia (a importação nunca cria GHE).',
  FUNCIONARIO_GHE_AMBIGUO: 'GHE ambíguo: mais de um GHE desta empresa tem este nome; escolha o GHE na prévia.',
  FUNCIONARIO_GHE_INVALIDO: 'GHE inválido: o nome tem caractere não permitido ou passa de 150 caracteres.',
  FUNCIONARIO_GHE_INATIVO: 'GHE inativo não aceita novos vínculos: reative o GHE ou informe outro.',
  FUNCIONARIO_JA_CADASTRADO: 'Já cadastrado — sem alterações.',
  FUNCIONARIO_JA_CADASTRADO_DIVERGENTE: 'Já cadastrado — dados divergentes. Nenhuma alteração realizada.',
  ERRO_INTERNO: 'Erro ao processar esta linha. Ela não foi gravada.',
};
const CODIGO_POR_CAMPO = {
  nome: 'FUNCIONARIO_NOME_INVALIDO',
  cpf: 'FUNCIONARIO_CPF_INVALIDO',
  matricula: 'FUNCIONARIO_MATRICULA_INVALIDA',
  dataAdmissao: 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA',
  dataNascimento: 'FUNCIONARIO_DATA_NASCIMENTO_INVALIDA',
  ghe: 'FUNCIONARIO_GHE_NAO_INFORMADO',
  situacao: 'FUNCIONARIO_SITUACAO_NAO_INFORMADA',
};
const MOTIVO_POR_CAMPO = {
  setor: 'Setor obrigatório (até 100 caracteres).',
  funcao: 'Função/cargo obrigatória (até 100 caracteres).',
  telefone: 'Telefone inválido (até 20 caracteres).',
};
const CAMPO_POR_CODIGO = {
  ...Object.fromEntries(Object.entries(CODIGO_POR_CAMPO).map(([campo, codigo]) => [codigo, campo])),
  FUNCIONARIO_GHE_INEXISTENTE: 'ghe', FUNCIONARIO_GHE_AMBIGUO: 'ghe', FUNCIONARIO_GHE_INVALIDO: 'ghe', FUNCIONARIO_GHE_INATIVO: 'ghe',
};
const CODIGOS_DUPLICIDADE = ['FUNCIONARIO_CPF_EM_USO', 'FUNCIONARIO_MATRICULA_EM_USO'];

// 12G-9: funcionário já existente (mesmo CPF nesta empresa) NUNCA é alterado,
// reativado ou completado; a linha é só comparada com o cadastro atual. Os
// campos sensíveis (CAMPOS_SENSIVEIS) apenas sinalizam a divergência, sem o
// valor atual — a mesma minimização do instantâneo de auditoria. Opcional
// vazio na planilha não é divergência (a planilha não afirma nada sobre ele).
const CAMPOS_COMPARADOS = ['matricula', 'nome', 'setor', 'funcao', 'dataAdmissao', 'dataNascimento', 'telefone'];
const CAMPOS_OPCIONAIS_PLANILHA = ['matricula', 'dataNascimento', 'telefone'];

function recusa(linha, codigo, campos) {
  return { linha, situacao: 'RECUSADO', codigo, motivo: MOTIVOS[codigo], campos };
}

async function compararComExistente(pool, empresaId, existente, dados, ghePlanilha) {
  const divergencias = [];
  for (const campo of CAMPOS_COMPARADOS) {
    const planilha = dados[campo] ?? null;
    if (planilha === null && CAMPOS_OPCIONAIS_PLANILHA.includes(campo)) {
      continue;
    }
    const atual = existente[campo] ?? null;
    if (atual !== planilha) {
      divergencias.push(CAMPOS_SENSIVEIS.includes(campo) ? { campo } : { campo, atual });
    }
  }
  const gheId = existente.grupoHomogeneoId ?? null;
  const gheAtual = gheId === null ? null : await gheRepo.buscarPorId(pool, empresaId, gheId);
  const nomeAtual = gheAtual === null ? null : gheAtual.nome;
  if (normalizarNomeGhe(nomeAtual) !== normalizarNomeGhe(ghePlanilha)) {
    divergencias.push({ campo: 'ghe', atual: nomeAtual });
  }
  return divergencias;
}

/** Recusa por validação de conteúdo (schema da linha): campos e motivo, sem valores. */
function recusaPorValidacao(linha, issues) {
  const campos = [...new Set(issues.map((i) => String(i.path[0])))];
  // GHE: "não informado" (vazio/whitespace) e "inválido" (controle proibido) têm códigos próprios, vindos do schema.
  const codigoGhe = issues.find((i) => String(i.path[0]) === 'ghe')?.params?.codigo === 'GHE_INVALIDO' ? 'FUNCIONARIO_GHE_INVALIDO' : 'FUNCIONARIO_GHE_NAO_INFORMADO';
  const codigo = campos[0] === 'ghe' ? codigoGhe : (CODIGO_POR_CAMPO[campos[0]] ?? 'FUNCIONARIO_DADOS_INVALIDOS');
  const motivo = campos.map((c) => (c === 'ghe' ? MOTIVOS[codigoGhe] : (CODIGO_POR_CAMPO[c] ? MOTIVOS[CODIGO_POR_CAMPO[c]] : (MOTIVO_POR_CAMPO[c] ?? MOTIVOS.FUNCIONARIO_DADOS_INVALIDOS)))).join(' ');
  return { linha, situacao: 'RECUSADO', codigo, motivo, campos };
}

/** Uma linha: validar → gravar na própria transação → resultado. Nunca lança. */
async function importarLinha(pool, { empresaId, atorId, ip, dispositivo, importacaoId }, bruta) {
  const linha = bruta.linha;
  const validada = linhaImportacao.safeParse(bruta);
  if (!validada.success) {
    return recusaPorValidacao(linha, validada.error.issues);
  }
  const v = validada.data;
  // Sem nome e sem escolha explícita (gheId): GHE não informado.
  if (v.ghe === undefined && v.gheId === undefined) {
    return recusa(linha, 'FUNCIONARIO_GHE_NAO_INFORMADO', ['ghe']);
  }
  // Só "Ativo" (caixa e espaços externos ignorados) é aceito; nenhum outro valor é convertido.
  const situacao = v.situacao.trim().toLowerCase();
  if (situacao === '') {
    return recusa(linha, 'FUNCIONARIO_SITUACAO_NAO_INFORMADA', ['situacao']);
  }
  if (situacao !== 'ativo') {
    return recusa(linha, 'FUNCIONARIO_SITUACAO_NAO_RECONHECIDA', ['situacao']);
  }
  try {
    const dados = prepararCadastro({
      matricula: v.matricula ?? null, nome: v.nome, cpf: v.cpf, grupoHomogeneoId: null,
      dataNascimento: v.dataNascimento ?? null, dataAdmissao: v.dataAdmissao,
      setor: v.setor, funcao: v.funcao, cracha: null, telefone: v.telefone ?? null,
    });
    // Regra oficial de existência: CPF único por empresa (uq_funcionarios_empresa_cpf).
    const existente = await funcionarioRepo.buscarPorCpf(pool, empresaId, dados.cpf);
    if (existente !== null) {
      const ghePlanilha = v.gheId === undefined ? v.ghe : (await gheRepo.buscarPorId(pool, empresaId, v.gheId))?.nome ?? null;
      const divergencias = await compararComExistente(pool, empresaId, existente, dados, ghePlanilha);
      const codigo = divergencias.length > 0 ? 'FUNCIONARIO_JA_CADASTRADO_DIVERGENTE' : 'FUNCIONARIO_JA_CADASTRADO';
      return {
        linha, situacao: 'JA_CADASTRADO', codigo, motivo: MOTIVOS[codigo], funcionarioId: existente.id, ativo: existente.ativo,
        ...(divergencias.length > 0 ? { divergencias } : {}),
      };
    }
    // GHE: a escolha explícita do SST (gheId) prevalece e é revalidada aqui (empresa da sessão, existência, ativo);
    // sem ela, resolução pelo nome normalizado: 0 = não encontrado, 1 = usa, >1 = ambíguo (nunca escolhe).
    let ghe;
    if (v.gheId !== undefined) {
      ghe = await gheRepo.buscarPorId(pool, empresaId, v.gheId);
      if (ghe === null) {
        return recusa(linha, 'FUNCIONARIO_GHE_INEXISTENTE', ['ghe']);
      }
    } else {
      const candidatos = await gheRepo.buscarPorNomeNormalizado(pool, empresaId, normalizarNomeGhe(v.ghe));
      if (candidatos.length === 0) {
        return recusa(linha, 'FUNCIONARIO_GHE_INEXISTENTE', ['ghe']);
      }
      if (candidatos.length > 1) {
        return recusa(linha, 'FUNCIONARIO_GHE_AMBIGUO', ['ghe']);
      }
      ghe = candidatos[0];
    }
    if (ghe.ativo !== true) {
      return recusa(linha, 'FUNCIONARIO_GHE_INATIVO', ['ghe']);
    }
    const funcionario = await emTransacao(pool, (client) => gravarCadastro(client, {
      empresaId, atorId, ip, dispositivo, dados: { ...dados, grupoHomogeneoId: ghe.id },
      contextoAuditoria: { origem: 'importacao', importacaoId, linha },
    }));
    return { linha, situacao: 'CADASTRADO', funcionarioId: funcionario.id };
  } catch (erro) {
    if (HttpError.ehHttpError(erro) && CODIGOS_DUPLICIDADE.includes(erro.codigo)) {
      // O existente (ativo ou inativo) NUNCA é alterado nem reativado.
      return { linha, situacao: 'DUPLICADO', codigo: erro.codigo, motivo: MOTIVOS[erro.codigo] };
    }
    if (HttpError.ehHttpError(erro) && erro.status < 500) {
      const campo = CAMPO_POR_CODIGO[erro.codigo];
      return {
        linha, situacao: 'RECUSADO', codigo: erro.codigo, motivo: MOTIVOS[erro.codigo] ?? MOTIVOS.FUNCIONARIO_DADOS_INVALIDOS,
        ...(campo ? { campos: [campo] } : {}),
      };
    }
    // Falha inesperada: a linha não foi gravada (ROLLBACK da sua transação);
    // as demais seguem. Log técnico só com identificadores — nunca a
    // mensagem do erro, que pode conter valores da linha.
    console.error('[importacao-funcionarios] erro inesperado ao gravar linha', {
      importacaoId, linha, codigo: erro && erro.code ? String(erro.code) : null,
    });
    return { linha, situacao: 'ERRO', codigo: 'ERRO_INTERNO', motivo: MOTIVOS.ERRO_INTERNO };
  }
}

/**
 * Importa um lote de até 100 linhas de uma planilha. Cada linha é
 * validada pelas mesmas regras do cadastro individual e gravada na SUA
 * transação: recusa, duplicidade ou erro de uma linha não desfaz nem
 * interrompe as outras. Funcionário existente nunca é alterado.
 *
 * Registra, ao final, UM evento de auditoria do lote com a declaração LGPD
 * efetivamente apresentada (versão e SHA-256 do texto), o usuário
 * responsável, os contadores e nenhum dado pessoal das linhas. A declaração
 * é do responsável pela importação — não é consentimento dos trabalhadores.
 *
 * A resposta traz um resultado por linha e nunca ecoa os valores da linha
 * (nome, CPF, telefone, datas, GHE). Para quem já existe (12G-9), devolve o
 * valor ATUAL do sistema só dos campos divergentes que o instantâneo de
 * auditoria também carrega; CPF nunca, nascimento e telefone só sinalizados.
 */
async function importar(pool, {
  empresaId, atorId, importacaoId, lote, arquivo, declaracaoLgpd: declaracao, linhas, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  if (!Array.isArray(linhas) || linhas.length === 0 || linhas.length > LINHAS_POR_LOTE) {
    throw new TypeError(`lote deve ter de 1 a ${LINHAS_POR_LOTE} linhas`);
  }
  if (!declaracao || declaracao.confirmada !== true || !declaracaoLgpd.versaoConhecida(declaracao.versao)) {
    throw HttpError.badRequest('IMPORTACAO_DECLARACAO_LGPD_INVALIDA', MSG_DECLARACAO_INVALIDA);
  }

  const resultados = [];
  for (const bruta of linhas) {
    // Sequencial: a ordem das linhas decide qual de duas linhas repetidas cadastra.
    // eslint-disable-next-line no-await-in-loop
    resultados.push(await importarLinha(pool, { empresaId, atorId, ip, dispositivo, importacaoId }, bruta));
  }

  const contar = (situacao) => resultados.filter((r) => r.situacao === situacao).length;
  const contarCodigo = (codigo) => resultados.filter((r) => r.codigo === codigo).length;
  const resumo = {
    cadastrados: contar('CADASTRADO'),
    jaCadastrados: contarCodigo('FUNCIONARIO_JA_CADASTRADO'),
    divergentes: contarCodigo('FUNCIONARIO_JA_CADASTRADO_DIVERGENTE'),
    duplicados: contar('DUPLICADO'),
    recusados: contar('RECUSADO'),
    erros: contar('ERRO'),
  };

  await emTransacao(pool, (client) => auditoriaRepo.registrar(client, {
    empresaId, usuarioId: atorId, acao: ACAO_AUDITORIA_IMPORTACAO_LOTE, referencia: importacaoId, ip, dispositivo,
    contexto: {
      versaoDeclaracao: declaracao.versao,
      hashTextoDeclaracao: declaracaoLgpd.hashDaVersao(declaracao.versao),
      declaracaoConfirmada: true,
      lote: lote.numero, totalLotes: lote.total,
      formato: arquivo.formato, nomeArquivo: arquivo.nome, totalLinhasArquivo: arquivo.totalLinhas,
      linhasNoLote: linhas.length,
      ...resumo,
      // Rastreabilidade por linha (12G-9): resultado, código, funcionário e nomes dos campos; nunca valores.
      linhas: resultados.map((r) => ({
        linha: r.linha, situacao: r.situacao, codigo: r.codigo ?? null, funcionarioId: r.funcionarioId ?? null,
        campos: r.campos ?? (r.divergencias ?? []).map((d) => d.campo),
      })),
    },
  }));

  return { importacaoId, lote: { numero: lote.numero, total: lote.total }, resumo, linhas: resultados };
}

/** Seletor de GHE do formulário de funcionário (S3): GHEs ativos da empresa da sessão, só id, código e descrição. */
async function listarGhesParaFormulario(pool, { empresaId }) {
  exigirId(empresaId, 'identificador de empresa');
  return gheRepo.listarAtivosParaFormulario(pool, empresaId);
}

/** Opções do seletor da prévia da importação (12K-E): GHEs ativos da empresa da sessão, só id e nome. */
async function listarGhesParaImportacao(pool, { empresaId }) {
  exigirId(empresaId, 'identificador de empresa');
  return gheRepo.listarAtivosParaSeletor(pool, empresaId);
}

module.exports = {
  criar, buscar, listar, alterar, inativar, reativar, alterarSituacao, revelarCpf, importar, listarGhesParaImportacao, listarGhesParaFormulario,
  ACAO_AUDITORIA_CPF_CONSULTADO,
};
