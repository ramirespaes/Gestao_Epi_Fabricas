'use strict';

const { HttpError } = require('../errors/HttpError');
const repo = require('../repositories/lgpd.repository');
const encarregadoRepo = require('../repositories/lgpd-encarregado.repository');

/**
 * Privacidade e LGPD (Bloco A1): resumo somente de leitura da empresa da sessão, com o que o sistema já tem de fato:
 * a controladora (razão social e CNPJ do cadastro), as contagens de titulares e, desde o LGPD-1, o encarregado (DPO)
 * principal e substituto vigentes — só os campos de contato profissional, sem ids nem histórico (o detalhe é do recurso
 * exclusivo lgpdEncarregado). Não há política, retenção nem solicitação de titular persistidas: não são inventadas aqui.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

const contatoPublicoInterno = (e) => (e === null ? null : {
  tipoPessoa: e.tipoPessoa, nome: e.nome, razaoSocial: e.razaoSocial, cnpj: e.cnpj, vinculo: e.vinculo, cargo: e.cargo, email: e.email, telefone: e.telefone, inicioEm: e.inicioEm,
});

async function resumir(pool, { empresaId }) {
  exigirId(empresaId, 'identificador de empresa');
  const controladora = await repo.buscarControladora(pool, empresaId);
  if (controladora === null) throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada');
  const titulares = await repo.contarTitulares(pool, empresaId);
  const vigentes = await encarregadoRepo.listarVigentes(pool, empresaId);
  const encarregado = { principal: contatoPublicoInterno(vigentes.principal), substituto: contatoPublicoInterno(vigentes.substituto) };
  return { controladora, titulares, encarregado };
}

module.exports = { resumir };
