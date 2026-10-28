'use strict';

const { HttpError } = require('../errors/HttpError');
const repo = require('../repositories/lgpd-encarregado.repository');
const auditoriaRepo = require('../repositories/auditoria.repository');
const autoridade = require('./autoridade-administrativa');
const usuarioAdministracao = require('./usuario-administracao.service');
const { dataOperacional } = require('../utils/data-operacional');

/**
 * Encarregado pelo tratamento de dados pessoais (DPO) — Pacote LGPD-1.
 *
 * AUTORIDADE (dupla barreira, sem bypass por nome de perfil): a rota já exigiu a linha do perfil (lgpdEncarregado.visualizar
 * para ler, .editar para escrever); cada escrita exige AINDA a autoridade administrativa da empresa (autoridade-administrativa.js,
 * a mesma da Gestão de Usuários) com ator MASTER — como escrever() de permissao-usuario.service. Um ADMINISTRADOR autorizado,
 * mesmo que uma linha de perfil lhe tenha sido criada por fora, é recusado (403 LGPD_DPO_SOMENTE_MASTER) e a tentativa é
 * auditada (LGPD_DPO_ACESSO_RECUSADO) numa transação própria.
 *
 * DADOS: um PRINCIPAL e um SUBSTITUTO vigentes por empresa (índice único parcial da 094). Substituir, corrigir contato e
 * encerrar nunca apagam nem reescrevem a designação: encerram a vigente (fim_em, motivo, versão) e, quando há sucessora,
 * inserem a nova apontando a anterior. `versao` do cliente é conferida no UPDATE (409 LGPD_DPO_VERSAO_DESATUALIZADA).
 *
 * COMPATIBILIDADE: as colunas legadas empresas.dpo_* (001) continuam intocadas e não são lidas por ninguém; a fonte de verdade
 * do encarregado é só lgpd_encarregados. A referência ao ato formal é declaratória: a empresa continua responsável pela
 * designação formal (Res. CD/ANPD 18/2024); nenhum campo aqui comprova validação jurídica.
 *
 * AUDITORIA (mesma transação do ato): LGPD_DPO_DESIGNADO, LGPD_DPO_SUBSTITUIDO, LGPD_DPO_CONTATO_ALTERADO, LGPD_DPO_ENCERRADO —
 * só ids, função, tipo, vínculo, datas, nomes de campos e códigos; nunca nome, razão social, e-mail, telefone ou o texto do ato.
 */

const PERFIL_MASTER = 'MASTER';
const ACAO = Object.freeze({
  DESIGNADO: 'LGPD_DPO_DESIGNADO',
  SUBSTITUIDO: 'LGPD_DPO_SUBSTITUIDO',
  CONTATO: 'LGPD_DPO_CONTATO_ALTERADO',
  ENCERRADO: 'LGPD_DPO_ENCERRADO',
  RECUSADO: 'LGPD_DPO_ACESSO_RECUSADO',
});
const ERRO = Object.freeze({
  NAO_AUTORIZADO: ['LGPD_DPO_NAO_AUTORIZADO', 'Sem autoridade para administrar o encarregado de dados'],
  SOMENTE_MASTER: ['LGPD_DPO_SOMENTE_MASTER', 'Somente o Master designa, substitui ou encerra o encarregado de dados'],
  NAO_ENCONTRADO: ['LGPD_DPO_NAO_ENCONTRADO', 'Designação não encontrada'],
  JA_VIGENTE: ['LGPD_DPO_JA_VIGENTE', 'Já existe uma designação vigente para esta função; use a substituição'],
  NAO_VIGENTE: ['LGPD_DPO_NAO_VIGENTE', 'Esta designação já está encerrada'],
  VERSAO: ['LGPD_DPO_VERSAO_DESATUALIZADA', 'A designação foi alterada por outra pessoa; recarregue e tente de novo'],
  SEM_ALTERACAO: ['LGPD_DPO_SEM_ALTERACAO', 'Nenhum contato foi alterado'],
  PERIODO: ['LGPD_DPO_PERIODO_INVALIDO', 'A data de encerramento não pode ser anterior ao início da designação'],
  CNPJ_NAO_SE_APLICA: ['LGPD_DPO_CNPJ_NAO_SE_APLICA', 'Só o encarregado pessoa jurídica tem CNPJ'],
  CNPJ_IMUTAVEL: ['LGPD_DPO_CNPJ_IMUTAVEL', 'O CNPJ gravado não é corrigido: outra pessoa jurídica é uma substituição'],
});
const CAMPOS_CONTATO = Object.freeze(['email', 'telefone', 'cargo']);

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

const apresentar = (e) => ({
  id: e.id,
  funcao: e.funcao,
  tipoPessoa: e.tipoPessoa,
  nome: e.nome,
  razaoSocial: e.razaoSocial,
  cnpj: e.cnpj,
  vinculo: e.vinculo,
  cargo: e.cargo,
  email: e.email,
  telefone: e.telefone,
  inicioEm: e.inicioEm,
  fimEm: e.fimEm,
  situacao: e.situacao,
  atoReferencia: e.atoReferencia,
  atoData: e.atoData,
  conflitoInteresses: e.conflitoInteresses,
  conflitoNota: e.conflitoNota,
  motivoEncerramento: e.motivoEncerramento,
  substituiId: e.substituiId,
  substituidaPorId: e.substituidaPorId,
  versao: e.versao,
  criadoEm: e.criadoEm,
});

async function consultar(pool, { empresaId }) {
  exigirId(empresaId, 'identificador de empresa');
  const v = await repo.listarVigentes(pool, empresaId);
  return { principal: v.principal === null ? null : apresentar(v.principal), substituto: v.substituto === null ? null : apresentar(v.substituto) };
}

async function historico(pool, { empresaId }) {
  exigirId(empresaId, 'identificador de empresa');
  return (await repo.listarHistorico(pool, empresaId)).map(apresentar);
}

/** Esqueleto das escritas: trava da empresa, autoridade administrativa, ator MASTER (recusa auditada fora da transação). */
async function escrever(pool, { empresaId, atorId, ip, dispositivo, operacao }, corpo) {
  exigirId(empresaId, 'identificador de empresa');
  exigirId(atorId, 'identificador de ator');
  let recusado = null;
  try {
    return await usuarioAdministracao.emTransacao(pool, async (client) => {
      await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [usuarioAdministracao.travaDaEmpresa(empresaId)]);
      const ator = await autoridade.exigirAutoridadeAdministrativa(
        client, empresaId, atorId, ...ERRO.NAO_AUTORIZADO, autoridade.ACOES_ADMINISTRATIVAS.USUARIOS,
      );
      if (ator.perfil !== PERFIL_MASTER) {
        recusado = ator;
        throw HttpError.forbidden(...ERRO.SOMENTE_MASTER);
      }
      return corpo(client, ator);
    });
  } finally {
    if (recusado !== null) {
      await auditoriaRepo.registrar(pool, {
        empresaId, usuarioId: recusado.id, acao: ACAO.RECUSADO, referencia: String(empresaId), ip, dispositivo, contexto: { operacao },
      });
    }
  }
}

const dadosDesignacao = (d) => ({
  funcao: d.funcao,
  tipoPessoa: d.tipoPessoa,
  nome: d.nome,
  razaoSocial: d.tipoPessoa === 'PJ' ? d.razaoSocial : null,
  cnpj: d.tipoPessoa === 'PJ' ? (d.cnpj ?? null) : null,
  vinculo: d.vinculo,
  cargo: d.cargo ?? null,
  email: d.email,
  telefone: d.telefone ?? null,
  inicioEm: d.inicioEm,
  atoReferencia: d.atoReferencia ?? null,
  atoData: d.atoData ?? null,
  conflitoInteresses: d.conflitoInteresses ?? 'NAO_AVALIADO',
  conflitoNota: d.conflitoNota ?? null,
});

const resumoAuditavel = (e) => ({
  funcao: e.funcao, tipoPessoa: e.tipoPessoa, vinculo: e.vinculo, inicioEm: e.inicioEm, atoInformado: e.atoReferencia !== null, conflitoInteresses: e.conflitoInteresses,
  temCnpj: e.cnpj !== null, // nunca o número
});

async function designar(pool, { empresaId, atorId, dados, ip = null, dispositivo = null }) {
  return escrever(pool, { empresaId, atorId, ip, dispositivo, operacao: 'designar' }, async (client, ator) => {
    const vigentes = await repo.listarVigentes(client, empresaId);
    if ((dados.funcao === 'PRINCIPAL' ? vigentes.principal : vigentes.substituto) !== null) {
      throw HttpError.conflict(...ERRO.JA_VIGENTE);
    }
    const novo = await repo.inserir(client, { empresaId, ...dadosDesignacao(dados), substituiId: null, designadoPor: ator.id });
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: ator.id, acao: ACAO.DESIGNADO, referencia: String(novo.id), ip, dispositivo, dadosNovos: resumoAuditavel(novo),
    });
    return apresentar(novo);
  });
}

async function carregarVigente(client, empresaId, id, versaoEsperada) {
  const atual = await repo.buscarPorId(client, empresaId, id, { travar: true });
  if (atual === null) throw HttpError.notFound(...ERRO.NAO_ENCONTRADO);
  if (atual.situacao !== 'VIGENTE') throw HttpError.conflict(...ERRO.NAO_VIGENTE);
  if (atual.versao !== versaoEsperada) throw HttpError.conflict(...ERRO.VERSAO);
  return atual;
}

async function encerrarVigente(client, { empresaId, atual, fimEm, motivo, ator }) {
  if (fimEm < atual.inicioEm) throw HttpError.badRequest(...ERRO.PERIODO);
  const encerrada = await repo.encerrar(client, {
    empresaId, id: atual.id, versaoEsperada: atual.versao, fimEm, motivo, encerradoPor: ator.id,
  });
  if (encerrada === null) throw HttpError.conflict(...ERRO.VERSAO);
  return encerrada;
}

/** Encerra a vigente, insere a sucessora (só então o índice de vigência admite outra) e grava o vínculo nos dois sentidos. */
async function suceder(client, { empresaId, atual, fimEm, motivo, ator, dadosSucessora }) {
  await encerrarVigente(client, { empresaId, atual, fimEm, motivo, ator });
  const nova = await repo.inserir(client, { empresaId, ...dadosSucessora, substituiId: atual.id, designadoPor: ator.id });
  const vinculada = await repo.vincularSucessora(client, { empresaId, id: atual.id, sucessoraId: nova.id });
  if (!vinculada) throw new Error(`lgpd_encarregados: vínculo da sucessora ${nova.id} com a designação ${atual.id} não gravado`);
  return nova;
}

async function substituir(pool, {
  empresaId, atorId, id, versao, fimAnteriorEm, dados, ip = null, dispositivo = null,
}) {
  exigirId(id, 'identificador do encarregado');
  return escrever(pool, { empresaId, atorId, ip, dispositivo, operacao: 'substituir' }, async (client, ator) => {
    const atual = await carregarVigente(client, empresaId, id, versao);
    if (dados.funcao !== atual.funcao) throw HttpError.badRequest('LGPD_DPO_FUNCAO_DIVERGENTE', 'A substituição mantém a função da designação substituída');
    const fimEm = fimAnteriorEm ?? dataOperacional();
    const novo = await suceder(client, { empresaId, atual, fimEm, motivo: 'SUBSTITUICAO', ator, dadosSucessora: dadosDesignacao(dados) });
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: ator.id, acao: ACAO.SUBSTITUIDO, referencia: String(novo.id), ip, dispositivo,
      dadosAnteriores: { encarregadoId: atual.id, fimEm },
      dadosNovos: { encarregadoId: novo.id, ...resumoAuditavel(novo) },
    });
    return apresentar(await repo.buscarPorId(client, empresaId, novo.id));
  });
}

async function corrigirContato(pool, {
  empresaId, atorId, id, versao, contato, ip = null, dispositivo = null,
}) {
  exigirId(id, 'identificador do encarregado');
  return escrever(pool, { empresaId, atorId, ip, dispositivo, operacao: 'contato' }, async (client, ator) => {
    const atual = await carregarVigente(client, empresaId, id, versao);
    const camposAlterados = CAMPOS_CONTATO.filter((c) => contato[c] !== undefined && contato[c] !== atual[c]);
    // CNPJ em "corrigir contato" só COMPLETA o legado PJ sem CNPJ (095); PF nunca tem; CNPJ gravado não se troca aqui.
    if (contato.cnpj !== undefined) {
      if (atual.tipoPessoa !== 'PJ') throw HttpError.badRequest(...ERRO.CNPJ_NAO_SE_APLICA);
      if (atual.cnpj !== null) throw HttpError.badRequest(...ERRO.CNPJ_IMUTAVEL);
      camposAlterados.push('cnpj');
    }
    if (camposAlterados.length === 0) throw HttpError.badRequest(...ERRO.SEM_ALTERACAO);
    // A correção não interrompe a designação: a linha nova herda o início; a anterior encerra no mesmo dia (histórico).
    const novo = await suceder(client, {
      empresaId, atual, fimEm: dataOperacional() < atual.inicioEm ? atual.inicioEm : dataOperacional(), motivo: 'CORRECAO', ator,
      dadosSucessora: dadosDesignacao({
        ...atual,
        email: contato.email ?? atual.email,
        telefone: contato.telefone === undefined ? atual.telefone : contato.telefone,
        cargo: contato.cargo === undefined ? atual.cargo : contato.cargo,
        cnpj: contato.cnpj ?? atual.cnpj,
      }),
    });
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: ator.id, acao: ACAO.CONTATO, referencia: String(novo.id), ip, dispositivo,
      dadosNovos: { encarregadoId: novo.id, anteriorId: atual.id, camposAlterados },
    });
    return apresentar(await repo.buscarPorId(client, empresaId, novo.id));
  });
}

async function encerrar(pool, {
  empresaId, atorId, id, versao, fimEm, ip = null, dispositivo = null,
}) {
  exigirId(id, 'identificador do encarregado');
  return escrever(pool, { empresaId, atorId, ip, dispositivo, operacao: 'encerrar' }, async (client, ator) => {
    const atual = await carregarVigente(client, empresaId, id, versao);
    const data = fimEm ?? dataOperacional();
    const encerrada = await encerrarVigente(client, { empresaId, atual, fimEm: data, motivo: 'ENCERRAMENTO', ator });
    await auditoriaRepo.registrar(client, {
      empresaId, usuarioId: ator.id, acao: ACAO.ENCERRADO, referencia: String(atual.id), ip, dispositivo,
      dadosNovos: { encarregadoId: atual.id, fimEm: data, motivo: 'ENCERRAMENTO' },
    });
    return apresentar(encerrada);
  });
}

module.exports = {
  consultar, historico, designar, substituir, corrigirContato, encerrar, ACAO, ERRO,
};
