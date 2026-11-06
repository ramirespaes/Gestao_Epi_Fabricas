'use strict';

const crypto = require('node:crypto');
const E = require('../../src/services/backup-fontes-cifra-envelope.service');
const H = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const Kms = require('../../src/services/backup-fontes-kms-pre-resolvido.service');
const X = require('../../src/services/backup-custodia-xor.service');
const Off = require('../../src/services/backup-fontes-recuperacao-offline.service');
const { criarKmsFalso } = require('./kms-falso');
const { ambienteS3 } = require('./ambiente-s3-falso');
const { novaRaiz, pacoteSintetico } = require('./pacote-l2-sintetico');

/**
 * Executor operacional: ambiente de teste SINTÉTICO completo (S3 falso por porta, destinos locais autorizados de teste, chaves do KMS falso pré-resolvido e as mesmas chaves
 * reconstruídas OFF-LINE das partes XOR, e um pacote L2 sintético). Nada contata a AWS; nada é real.
 */

const SEG_MAC = crypto.randomBytes(32);
const SEG_KEK = crypto.randomBytes(32);
const dMac = X.dividirSegredo({ chaveId: 'mac-hml-v1', segredo: SEG_MAC });
const dKek = X.dividirSegredo({ chaveId: 'kek-hml-v1', segredo: SEG_KEK });

async function chavesDeOperacao(ficha) {
  const kms = criarKmsFalso();
  const ctx = (finalidade, chaveId) => Kms.contextoDeCriptografia({ ambiente: 'HOMOLOGACAO', finalidade, chaveId });
  const provedor = Kms.criarProvedoresKmsPreResolvidos({
    ficha, cliente: kms.cliente, prazoMs: 1000,
    chaves: {
      mac: [{ chaveId: 'mac-hml-v1', estado: 'ATIVA', blob: kms.cifrar({ chaveArn: ficha.chaveMac, contexto: ctx('MAC', 'mac-hml-v1'), segredo: SEG_MAC }), vc: X.valorDeVerificacao('mac-hml-v1', SEG_MAC) }],
      cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', blob: kms.cifrar({ chaveArn: ficha.chaveCifra, contexto: ctx('CIFRA', 'kek-hml-v1'), segredo: SEG_KEK }), vc: X.valorDeVerificacao('kek-hml-v1', SEG_KEK) }],
    },
  });
  await provedor.resolver();
  return provedor;
}
const comoFontes = (provedor, macId = 'mac-hml-v1', kekId = 'kek-hml-v1') => {
  const fonteMac = H.criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: provedor.mac });
  const fonteCifra = E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: kekId, segredo: provedor.cifra.obter(kekId).segredo }] });
  return { fonteMac, chaves: { cifra: { fonte: fonteCifra, chaveId: kekId }, mac: { fonte: fonteMac, chaveId: macId } } };
};
const chavesOffline = () => comoFontes(Off.criarProvedoresDeRecuperacaoOffline({ chaves: {
  mac: [{ chaveId: 'mac-hml-v1', estado: 'ATIVA', pacotes: [dMac.pacotes[2], dMac.pacotes[1]] }],
  cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', pacotes: [dKek.pacotes[0], dKek.pacotes[2]] }],
} }));

/** `s3`: opções de `ambienteS3` (configuração do bucket falso, tamanho de bloco). */
async function prepararAmbiente({ s3 = {}, conjuntoId = 'conjunto-exec' } = {}) {
  const a = ambienteS3({ bloco: 4096, ...s3 });
  const raiz = novaRaiz();
  const operacao = await chavesDeOperacao(a.ficha);
  const { fonteMac, chaves } = comoFontes(operacao);
  const pacote = pacoteSintetico(raiz, { fonteMac, macId: 'mac-hml-v1', conjuntoId });
  const dlContainers = a.destinoLocal(raiz, { id: 'containers-teste', nome: 'containers' });
  const dlRestauracao = a.destinoLocal(raiz, { id: 'restauracao-teste', nome: 'restauracoes' });
  return { a, raiz, fonteMac, chaves, pacote, dlContainers, dlRestauracao, conjuntoId };
}

module.exports = { prepararAmbiente, chavesDeOperacao, chavesOffline, comoFontes, SEG_MAC, SEG_KEK };
