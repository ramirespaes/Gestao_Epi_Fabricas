'use strict';

const { HttpError } = require('../errors/HttpError');
const empresaRepo = require('../repositories/empresa.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const { normalizarOpcional, exigirCoerenciaIe } = require('../utils/empresa-campos');

/**
 * Dados da Empresa no Portal: a empresa da SESSÃO consulta e atualiza o próprio cadastro. A fonte é a tabela `empresas`, a mesma do
 * Painel Privado; este serviço não cria cadastro paralelo.
 *
 * RAZÃO SOCIAL E CNPJ SÃO DA SAFEWORK: nenhuma chamada pelo Portal os altera, mesmo direta na API. Camadas: o schema não os declara
 * (400 CAMPO_NAO_PERMITIDO); este serviço recusa a chave de novo; o repositório só aceita a lista branca CAMPOS_PORTAL e a consulta
 * não tem as colunas `nome` e `cnpj`.
 *
 * EMPRESA: sempre `empresaId` da sessão (o controller nunca lê empresa do cliente). Outra empresa nunca é alcançável por aqui.
 *
 * CONCORRÊNCIA: a linha é travada (FOR UPDATE), a versão carregada pelo cliente é conferida e o UPDATE ainda leva `WHERE versao = $n`
 * (comparação-e-troca atômica). Versão antiga = 409 EMPRESA_DADOS_DESATUALIZADOS, sem gravar nada e sem devolver dados. A versão
 * nova é do gatilho da migration 091: só avança quando algum valor mudou.
 *
 * AUDITORIA: `EMPRESA_DADOS_ALTERADOS` em logs_auditoria, só com os NOMES dos campos alterados e as versões; nunca os valores
 * (telefone e e-mails são dados pessoais). Sem mudança real não há gravação nem auditoria.
 */

const ACAO_AUDITORIA = 'EMPRESA_DADOS_ALTERADOS';
const CAMPOS_BLOQUEADOS = Object.freeze(['razaoSocial', 'cnpj']);
const CHAVES_PROIBIDAS = Object.freeze(['razaoSocial', 'cnpj', 'nome', 'ativo', 'empresaId', 'empresa_id', 'usuarioId', 'id']);

const MSG = Object.freeze({
  NAO_ENCONTRADA: 'Empresa não encontrada',
  DESATUALIZADA: 'Os dados da empresa foram alterados por outra pessoa. Recarregue antes de salvar.',
  DADOS: 'Dados cadastrais da empresa inválidos',
  SEM_ALTERACAO: 'Nenhum campo para alterar',
  CAMPO_NAO_PERMITIDO: 'Campo não permitido',
});

const TAMANHOS = new Map(empresaRepo.CAMPOS_PORTAL.map(([chave, , tamanho]) => [chave, tamanho]));

// Valor atual de cada campo editável na projeção detalhada (contatos aninhados).
const LEITORES = Object.freeze({
  representanteNome: (e) => e.representante.nome,
  representanteCargo: (e) => e.representante.cargo,
  representanteEmail: (e) => e.representante.email,
  representanteTelefone: (e) => e.representante.telefone,
  financeiroNome: (e) => e.financeiro.nome,
  financeiroEmail: (e) => e.financeiro.email,
  financeiroTelefone: (e) => e.financeiro.telefone,
});
const valorAtual = (empresa, chave) => (LEITORES[chave] ? LEITORES[chave](empresa) : empresa[chave]);

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

/** Projeção entregue ao Portal: sem `ativo`, carimbos nem id (a empresa é a da sessão). */
const projetar = (e) => ({
  razaoSocial: e.razaoSocial,
  cnpj: e.cnpj,
  nomeFantasia: e.nomeFantasia,
  inscricaoEstadual: e.inscricaoEstadual,
  situacaoInscricaoEstadual: e.situacaoInscricaoEstadual,
  endereco: e.endereco,
  numero: e.numero,
  complemento: e.complemento,
  bairro: e.bairro,
  cidade: e.cidade,
  uf: e.uf,
  cep: e.cep,
  telefone: e.telefone,
  email: e.email,
  emailSst: e.emailSst,
  emailAlmoxarifado: e.emailAlmoxarifado,
  representante: e.representante,
  financeiro: e.financeiro,
  versao: e.versao,
  camposBloqueados: [...CAMPOS_BLOQUEADOS],
});

async function consultar(pool, { empresaId }) {
  exigirId(empresaId, 'identificador de empresa');
  const empresa = await empresaRepo.buscarDetalhesPorId(pool, empresaId);
  if (empresa === null) {
    throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', MSG.NAO_ENCONTRADA);
  }
  return projetar(empresa);
}

/**
 * @param {import('pg').Pool} pool
 * @param {{empresaId: number, usuarioId: number, versaoEsperada: number, campos: object, ip?: string|null, dispositivo?: string|null}} dados
 *   `campos` traz SÓ as chaves informadas (valor ou null para limpar).
 * @returns {Promise<{dados: object, alterado: boolean, camposAlterados: string[]}>}
 */
async function alterar(pool, {
  empresaId, usuarioId, versaoEsperada, campos, ip = null, dispositivo = null,
}) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(usuarioId, 'identificador de usuário');
  exigirId(versaoEsperada, 'versão esperada');

  const chaves = Object.keys(campos ?? {});
  if (chaves.some((c) => CHAVES_PROIBIDAS.includes(c) || !TAMANHOS.has(c))) {
    throw HttpError.badRequest('CAMPO_NAO_PERMITIDO', MSG.CAMPO_NAO_PERMITIDO);
  }
  if (chaves.length === 0) {
    throw HttpError.badRequest('EMPRESA_SEM_ALTERACAO', MSG.SEM_ALTERACAO);
  }

  const normalizados = {};
  for (const chave of chaves) {
    const valor = normalizarOpcional(chave, campos[chave], TAMANHOS.get(chave));
    if (valor === undefined) {
      throw HttpError.badRequest('EMPRESA_DADOS_INVALIDOS', MSG.DADOS);
    }
    normalizados[chave] = valor;
  }

  return emTransacao(pool, async (client) => {
    const anterior = await empresaRepo.buscarDetalhesPorIdParaAtualizacao(client, empresaId);
    if (anterior === null) {
      throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', MSG.NAO_ENCONTRADA);
    }
    if (anterior.versao !== versaoEsperada) {
      throw HttpError.conflict('EMPRESA_DADOS_DESATUALIZADOS', MSG.DESATUALIZADA);
    }

    // Só entra no UPDATE (e na auditoria) o que realmente muda.
    const mudancas = {};
    for (const chave of chaves) {
      if (normalizados[chave] !== valorAtual(anterior, chave)) {
        mudancas[chave] = normalizados[chave];
      }
    }
    const camposAlterados = Object.keys(mudancas);

    // Coerência da inscrição estadual avaliada sobre o estado RESULTANTE.
    exigirCoerenciaIe({
      situacaoInscricaoEstadual: Object.hasOwn(mudancas, 'situacaoInscricaoEstadual') ? mudancas.situacaoInscricaoEstadual : anterior.situacaoInscricaoEstadual,
      inscricaoEstadual: Object.hasOwn(mudancas, 'inscricaoEstadual') ? mudancas.inscricaoEstadual : anterior.inscricaoEstadual,
    });

    if (camposAlterados.length === 0) {
      return { dados: projetar(anterior), alterado: false, camposAlterados };
    }

    const atualizada = await empresaRepo.atualizarDadosEmpresariais(client, empresaId, mudancas, versaoEsperada);
    if (atualizada === null) {
      throw HttpError.conflict('EMPRESA_DADOS_DESATUALIZADOS', MSG.DESATUALIZADA);
    }

    await auditoriaRepo.registrar(client, {
      empresaId,
      usuarioId,
      acao: ACAO_AUDITORIA,
      referencia: String(empresaId),
      ip,
      dispositivo,
      contexto: { camposAlterados, versaoAnterior: anterior.versao, versaoNova: atualizada.versao },
    });

    return { dados: projetar(atualizada), alterado: true, camposAlterados };
  });
}

module.exports = { consultar, alterar, ACAO_AUDITORIA, CAMPOS_BLOQUEADOS };
