'use strict';

const { normalizarCnpj } = require('../utils/normalizacao');

/**
 * Repositório de empresas.
 *
 * A empresa é a raiz do isolamento multiempresa: toda consulta de negócio
 * parte dela. Por isso este é o primeiro repositório e o que fixa o padrão
 * dos demais.
 *
 * O executor de consultas chega por parâmetro e nunca é importado. Ele pode
 * ser o pool, um cliente dentro de transação ou, no futuro, a conexão
 * escolhida para a empresa autenticada. Importar o pool aqui obrigaria a
 * reescrever todos os repositórios quando cada contratante tiver seu próprio
 * banco.
 *
 * O repositório consulta e devolve, sem decidir regra de negócio. Ausência é
 * null, não exceção, porque quem precisa responder de forma indistinguível
 * para empresa inexistente e senha errada é o serviço de autenticação.
 *
 * As consultas são sempre parametrizadas e projetam apenas os campos
 * necessários. Dados cadastrais que não participam da autenticação, como os
 * do encarregado de proteção de dados, não são trazidos.
 */

const CAMPOS_PUBLICOS = Object.freeze(['id', 'nome', 'cnpj', 'ativo']);
const PROJECAO = CAMPOS_PUBLICOS.join(', ');

/**
 * O CNPJ precisa chegar já normalizado. Normalizar aqui dentro esconderia de
 * quem chama o fato de que a forma canônica é responsabilidade da camada
 * acima, e abriria espaço para o mesmo valor ser consultado de duas formas.
 */
function exigirCnpjNormalizado(cnpj) {
  if (typeof cnpj !== 'string' || normalizarCnpj(cnpj) !== cnpj) {
    throw new TypeError('cnpj deve chegar normalizado');
  }
}

function exigirIdentificador(id) {
  if (!Number.isInteger(id) || id <= 0) {
    throw new TypeError('identificador de empresa inválido');
  }
}

const mapear = (linha) => (linha === undefined ? null : {
  id: linha.id,
  nome: linha.nome,
  cnpj: linha.cnpj,
  ativo: linha.ativo,
});

/**
 * Busca a empresa pelo CNPJ canônico. É o primeiro passo do login: sem
 * empresa não há usuário a procurar.
 *
 * @param {{query: Function}} executor
 * @param {string} cnpj já normalizado
 * @returns {Promise<{id: number, nome: string, cnpj: string, ativo: boolean}|null>}
 */
async function buscarPorCnpj(executor, cnpj) {
  exigirCnpjNormalizado(cnpj);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM empresas WHERE cnpj = $1`,
    [cnpj],
  );

  return mapear(rows[0]);
}

/**
 * Busca a empresa pelo identificador, usado para recarregar o contexto a
 * partir de uma sessão já existente.
 */
async function buscarPorId(executor, id) {
  exigirIdentificador(id);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO} FROM empresas WHERE id = $1`,
    [id],
  );

  return mapear(rows[0]);
}

/**
 * Função própria, e não uma condição embutida na consulta de sessão, porque
 * o que torna uma empresa apta a usar o sistema tende a crescer: hoje é a
 * coluna ativo, adiante pode incluir situação de assinatura e liberação
 * provisória. Quem chama continua perguntando a mesma coisa.
 */
async function existeAtiva(executor, id) {
  exigirIdentificador(id);

  const { rows } = await executor.query(
    'SELECT EXISTS (SELECT 1 FROM empresas WHERE id = $1 AND ativo) AS existe',
    [id],
  );

  return rows[0] !== undefined && rows[0].existe === true;
}

// ---------------------------------------------------------------------------
// CADASTRO CENTRALIZADO (Pacote 3 — Painel Privado). Tudo abaixo é NOVO e
// ADITIVO: buscarPorCnpj/buscarPorId/existeAtiva/CAMPOS_PUBLICOS acima
// continuam exatamente como o login.service.js (Pacotes 1/2) os usa, com a
// mesma projeção estreita. As funções administrativas têm nomes próprios e
// projeção própria (PROJECAO_DETALHADA) de propósito — o contexto de sessão
// empresarial nunca passa a carregar contatos, IE ou endereço por acidente.
//
// SEM EXCLUSÃO FÍSICA: empresa é inativada (ativo=false). CNPJ é IMUTÁVEL
// após o cadastro (mesma disciplina do CPF de funcionário, Bloco 9): não
// há cláusula para `cnpj` em atualizar(), e a chave é recusada.
// ---------------------------------------------------------------------------

const { escaparCoringasLike } = require('../utils/like');

// Limites das colunas (migrations 001 e 032).
const TAMANHOS = Object.freeze({
  NOME: 150, NOME_FANTASIA: 150, INSCRICAO_ESTADUAL: 20, SITUACAO_IE: 30,
  ENDERECO: 200, NUMERO: 20, COMPLEMENTO: 100, BAIRRO: 100, CIDADE: 100, CEP: 9,
  TELEFONE: 20, EMAIL: 150, NOME_CONTATO: 150, CARGO: 100,
});
const UF_FORMATO = /^[A-Z]{2}$/;
const SITUACAO_IE_FORMATO = /^[A-Z_]{1,30}$/;

const PROJECAO_DETALHADA = `id, nome, nome_fantasia, cnpj, inscricao_estadual, situacao_inscricao_estadual,
  endereco, numero, complemento, bairro, cidade, uf, cep, telefone, email,
  representante_nome, representante_cargo, representante_email, representante_telefone,
  financeiro_nome, financeiro_email, financeiro_telefone,
  ativo, criado_em, atualizado_em`;

// Campos OPCIONAIS editáveis pelo cadastro (todos nulos por padrão), na
// ordem em que entram no INSERT/UPDATE. `cnpj` e `nome` são obrigatórios e
// ficam fora desta lista; `ativo` só muda por atualizarEstado().
const CAMPOS_OPCIONAIS = Object.freeze([
  ['nomeFantasia', 'nome_fantasia', TAMANHOS.NOME_FANTASIA],
  ['inscricaoEstadual', 'inscricao_estadual', TAMANHOS.INSCRICAO_ESTADUAL],
  ['situacaoInscricaoEstadual', 'situacao_inscricao_estadual', TAMANHOS.SITUACAO_IE],
  ['endereco', 'endereco', TAMANHOS.ENDERECO],
  ['numero', 'numero', TAMANHOS.NUMERO],
  ['complemento', 'complemento', TAMANHOS.COMPLEMENTO],
  ['bairro', 'bairro', TAMANHOS.BAIRRO],
  ['cidade', 'cidade', TAMANHOS.CIDADE],
  ['uf', 'uf', 2],
  ['cep', 'cep', TAMANHOS.CEP],
  ['telefone', 'telefone', TAMANHOS.TELEFONE],
  ['email', 'email', TAMANHOS.EMAIL],
  ['representanteNome', 'representante_nome', TAMANHOS.NOME_CONTATO],
  ['representanteCargo', 'representante_cargo', TAMANHOS.CARGO],
  ['representanteEmail', 'representante_email', TAMANHOS.EMAIL],
  ['representanteTelefone', 'representante_telefone', TAMANHOS.TELEFONE],
  ['financeiroNome', 'financeiro_nome', TAMANHOS.NOME_CONTATO],
  ['financeiroEmail', 'financeiro_email', TAMANHOS.EMAIL],
  ['financeiroTelefone', 'financeiro_telefone', TAMANHOS.TELEFONE],
]);

function exigirTexto(valor, nome, tamanhoMaximo) {
  if (typeof valor !== 'string' || valor.length === 0 || valor.length > tamanhoMaximo) {
    throw new TypeError(`${nome} inválido`);
  }
}

function exigirOpcional(chave, valor, tamanhoMaximo) {
  if (valor === null) {
    return;
  }
  if (chave === 'uf') {
    if (typeof valor !== 'string' || !UF_FORMATO.test(valor)) {
      throw new TypeError('uf inválida');
    }
    return;
  }
  if (chave === 'situacaoInscricaoEstadual') {
    if (typeof valor !== 'string' || !SITUACAO_IE_FORMATO.test(valor)) {
      throw new TypeError('situação da inscrição estadual inválida');
    }
    return;
  }
  exigirTexto(valor, chave, tamanhoMaximo);
}

const mapearDetalhado = (linha) => (linha === undefined ? null : {
  id: linha.id,
  razaoSocial: linha.nome,
  nomeFantasia: linha.nome_fantasia,
  cnpj: linha.cnpj,
  inscricaoEstadual: linha.inscricao_estadual,
  situacaoInscricaoEstadual: linha.situacao_inscricao_estadual,
  endereco: linha.endereco,
  numero: linha.numero,
  complemento: linha.complemento,
  bairro: linha.bairro,
  cidade: linha.cidade,
  uf: linha.uf,
  cep: linha.cep,
  telefone: linha.telefone,
  email: linha.email,
  representante: { nome: linha.representante_nome, cargo: linha.representante_cargo, email: linha.representante_email, telefone: linha.representante_telefone },
  financeiro: { nome: linha.financeiro_nome, email: linha.financeiro_email, telefone: linha.financeiro_telefone },
  ativo: linha.ativo,
  criadoEm: linha.criado_em,
  atualizadoEm: linha.atualizado_em,
});

/**
 * Cria uma empresa com o cadastro completo. `razaoSocial` vai para a
 * coluna `nome` (ver migration 032). `cnpj` chega JÁ normalizado e com DV
 * conferido pelo serviço. Propaga uq_empresas_cnpj sem traduzir.
 */
async function criar(executor, { razaoSocial, cnpj, ...opcionais }) {
  exigirTexto(razaoSocial, 'razão social', TAMANHOS.NOME);
  exigirCnpjNormalizado(cnpj);
  const valores = CAMPOS_OPCIONAIS.map(([chave, , tamanho]) => {
    const valor = opcionais[chave] ?? null;
    exigirOpcional(chave, valor, tamanho);
    return valor;
  });
  const colunas = CAMPOS_OPCIONAIS.map(([, coluna]) => coluna).join(', ');
  const marcadores = CAMPOS_OPCIONAIS.map((_, i) => `$${i + 3}`).join(', ');

  const { rows } = await executor.query(
    `INSERT INTO empresas (nome, cnpj, ${colunas})
     VALUES ($1, $2, ${marcadores})
     RETURNING ${PROJECAO_DETALHADA}`,
    [razaoSocial, cnpj, ...valores],
  );

  return mapearDetalhado(rows[0]);
}

async function buscarDetalhesPorId(executor, id) {
  exigirIdentificador(id);
  const { rows } = await executor.query(`SELECT ${PROJECAO_DETALHADA} FROM empresas WHERE id = $1`, [id]);
  return mapearDetalhado(rows[0]);
}

/** Igual a buscarDetalhesPorId, com FOR UPDATE (dentro de transação). */
async function buscarDetalhesPorIdParaAtualizacao(executor, id) {
  exigirIdentificador(id);
  const { rows } = await executor.query(`SELECT ${PROJECAO_DETALHADA} FROM empresas WHERE id = $1 FOR UPDATE`, [id]);
  return mapearDetalhado(rows[0]);
}

function validarFiltros({ ativo, busca, pagina, limite }) {
  if (ativo !== null && typeof ativo !== 'boolean') {
    throw new TypeError('filtro ativo deve ser booleano ou null');
  }
  if (busca !== null && typeof busca !== 'string') {
    throw new TypeError('filtro de busca deve ser string ou null');
  }
  if (pagina !== undefined && (!Number.isInteger(pagina) || pagina < 1)) {
    throw new TypeError('página inválida');
  }
  if (limite !== undefined && (!Number.isInteger(limite) || limite < 1)) {
    throw new TypeError('limite inválido');
  }
}

/** Lista para o Painel Privado: busca por razão social, nome fantasia ou CNPJ (texto literal, sem coringas). */
async function listar(executor, { ativo = null, busca = null, pagina = 1, limite = 20 } = {}) {
  validarFiltros({ ativo, busca, pagina, limite });
  const buscaEscapada = busca === null ? null : escaparCoringasLike(busca);

  const { rows } = await executor.query(
    `SELECT ${PROJECAO_DETALHADA}
       FROM empresas
      WHERE ($1::boolean IS NULL OR ativo = $1::boolean)
        AND ($2::text IS NULL OR nome ILIKE '%' || $2::text || '%' OR nome_fantasia ILIKE '%' || $2::text || '%' OR cnpj ILIKE '%' || $2::text || '%')
      ORDER BY lower(nome), id
      LIMIT $3 OFFSET $4`,
    [ativo, buscaEscapada, limite, (pagina - 1) * limite],
  );

  return rows.map((linha) => mapearDetalhado(linha));
}

async function contar(executor, { ativo = null, busca = null } = {}) {
  validarFiltros({ ativo, busca });
  const buscaEscapada = busca === null ? null : escaparCoringasLike(busca);

  const { rows } = await executor.query(
    `SELECT count(*)::int AS total
       FROM empresas
      WHERE ($1::boolean IS NULL OR ativo = $1::boolean)
        AND ($2::text IS NULL OR nome ILIKE '%' || $2::text || '%' OR nome_fantasia ILIKE '%' || $2::text || '%' OR cnpj ILIKE '%' || $2::text || '%')`,
    [ativo, buscaEscapada],
  );

  return rows[0].total;
}

/**
 * Atualiza o cadastro. `razaoSocial` null = não mexer. Para cada opcional,
 * a flag `<campo>Informado` distingue "não mexer" de "limpar para null"
 * (mesmo contrato de funcionario.repository.atualizar). `cnpj` NUNCA é
 * aceito; `ativo` só por atualizarEstado().
 *
 * @returns {Promise<object|null>} empresa atualizada, ou null se não existe
 */
async function atualizar(executor, id, campos = {}) {
  if (Object.hasOwn(campos, 'cnpj')) {
    throw new TypeError('cnpj não pode ser alterado após o cadastro');
  }
  if (Object.hasOwn(campos, 'ativo')) {
    throw new TypeError('ativo só muda por atualizarEstado');
  }
  exigirIdentificador(id);
  const { razaoSocial = null } = campos;
  if (razaoSocial !== null) {
    exigirTexto(razaoSocial, 'razão social', TAMANHOS.NOME);
  }

  const sets = ['nome = COALESCE($2, nome)'];
  const valores = [id, razaoSocial];
  for (const [chave, coluna, tamanho] of CAMPOS_OPCIONAIS) {
    const informado = campos[`${chave}Informado`] === true;
    const valor = informado ? (campos[chave] ?? null) : null;
    if (informado) {
      exigirOpcional(chave, valor, tamanho);
    }
    valores.push(informado, valor);
    sets.push(`${coluna} = CASE WHEN $${valores.length - 1}::boolean THEN $${valores.length} ELSE ${coluna} END`);
  }

  const { rows } = await executor.query(
    `UPDATE empresas SET ${sets.join(', ')} WHERE id = $1 RETURNING ${PROJECAO_DETALHADA}`,
    valores,
  );

  return mapearDetalhado(rows[0]);
}

/** Única função que altera `ativo`. @returns empresa atualizada ou null. */
async function atualizarEstado(executor, id, ativo) {
  exigirIdentificador(id);
  if (typeof ativo !== 'boolean') {
    throw new TypeError('ativo deve ser booleano');
  }
  const { rows } = await executor.query(
    `UPDATE empresas SET ativo = $2 WHERE id = $1 RETURNING ${PROJECAO_DETALHADA}`,
    [id, ativo],
  );
  return mapearDetalhado(rows[0]);
}

module.exports = {
  buscarPorCnpj,
  buscarPorId,
  existeAtiva,
  CAMPOS_PUBLICOS,
  // Pacote 3 — cadastro centralizado (Painel Privado)
  criar,
  buscarDetalhesPorId,
  buscarDetalhesPorIdParaAtualizacao,
  listar,
  contar,
  atualizar,
  atualizarEstado,
  CAMPOS_OPCIONAIS,
  TAMANHOS,
};
