'use strict';

const { HttpError } = require('../errors/HttpError');
const suporteRepo = require('../repositories/suporte.repository');
const { TIPOS } = require('../email/templates');

/**
 * Gestão de E-mails (Bloco A1): resumo somente de leitura com o que existe de fato e é confiável: o catálogo de templates
 * transacionais (fixo em código), se os canais da empresa (SST e Almoxarifado) têm e-mail cadastrado (nunca o endereço) e
 * se a entrega está configurada no ambiente (booleano, sem host, porta ou credencial). Não há registro consolidado de
 * envios no sistema, então nenhuma contagem de envios é devolvida.
 */

function exigirId(valor, nome) {
  if (!Number.isInteger(valor) || valor <= 0) throw new TypeError(`${nome} inválido`);
}

async function resumir(pool, { empresaId }, { emailConfig }) {
  exigirId(empresaId, 'identificador de empresa');
  const e = await suporteRepo.buscarEmailsDaEmpresa(pool, empresaId);
  if (e === null) throw HttpError.notFound('EMPRESA_NAO_ENCONTRADA', 'Empresa não encontrada');
  return {
    templates: Object.values(TIPOS).map((tipo) => ({ tipo })),
    canais: { almoxarifado: { configurado: e.emailAlmoxarifado !== null }, sst: { configurado: e.emailSst !== null } },
    entrega: { ativa: emailConfig.modo !== 'desativado' },
  };
}

module.exports = { resumir };
