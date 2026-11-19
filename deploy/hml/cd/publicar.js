'use strict';
const fs = require('node:fs');
const N = require('../instalador/nucleo');
const P = require('./protocolo');
const { criarS3, PREFIXO_POR_ESCOPO } = require('./s3');
// Prefixo S3 por escopo. O frontend continua em hml/ (o que o agente atual lê). O backend usa hml-backend/, onde NENHUM
// agente lê: nesta etapa o pedido do backend é só registrado e nada o executa.
function prefixoDoEscopo(escopo) {
  P.exigir(typeof escopo === 'string' && Object.hasOwn(PREFIXO_POR_ESCOPO, escopo), 'ESCOPO_INVALIDO');
  return PREFIXO_POR_ESCOPO[escopo];
}
async function publicar({ dir, commit, rotulo, releaseSha256, id, permitirAnterior = false, escopo = 'frontend', s3, agora = Date.now, esperar = ms => new Promise(r => setTimeout(r, ms)), tentativas = 60 }) {
  const prefixo = prefixoDoEscopo(escopo);
  const blob = P.empacotar(dir, { commit, rotulo, releaseSha256, escopo });
  const t = agora();
  const corpo = { repositorio: P.REPO, id, commit, rotulo, releaseSha256, blobSha256: N.sha256(blob), permitirAnterior, criadoEm: new Date(t).toISOString(), expiraEm: new Date(t + 8 * 60000).toISOString() };
  // Frontend: pedido v1, idêntico ao de sempre. Backend: pedido v2 com o escopo explícito.
  const pedido = P.validarPedido(escopo === 'backend' ? { versao: 2, escopo, ...corpo } : { versao: 1, ...corpo }, t, { escopo });
  // O pedido é a autorização; só existe depois de o conteúdo estar completo.
  await s3.put(`${prefixo}/blobs/${id}.json`, blob);
  await s3.put(`${prefixo}/pedidos/${id}.json`, Buffer.from(JSON.stringify(pedido)));
  for (let i = 0; i < tentativas; i++) {
    const b = await s3.get(`${prefixo}/recibos/${id}.json`);
    if (b !== null) return P.validarRecibo(P.json(b), pedido);
    await esperar(10000);
  }
  throw Object.assign(new Error('SEM_RECIBO_CONCLUSIVO'), { codigo: 'SEM_RECIBO_CONCLUSIVO' });
}
// Manual: exige publicar=true, confirmação literal e decisão explícita sobre commit anterior.
// Automático (workflow_run do CI verde na main): a validação do workflow já provou CI, SHA e posição na
// main; aqui só se aceita tentativa 1 e nunca release retroativa.
// Backend: SOMENTE manual, pelo workflow deploy-hml-backend.yml na main, com interruptor, confirmação e role próprios,
// tentativa 1, sem commit anterior e nunca retroativo. Nada do frontend (interruptor, confirmação) vale aqui e vice-versa.
function decidirContextoBackend(e) {
  const workflow = `${P.REPO}/.github/workflows/deploy-hml-backend.yml@refs/heads/main`;
  const rotulo = e.HML_ROTULO;
  P.exigir(e.GITHUB_REPOSITORY === P.REPO && e.GITHUB_REF === 'refs/heads/main' && e.GITHUB_WORKFLOW_REF === workflow
    && e.GITHUB_EVENT_NAME === 'workflow_dispatch' && e.GITHUB_RUN_ATTEMPT === '1'
    && e.HML_BACKEND_HABILITADA === 'true' && e.HML_PUBLICAR === 'true' && e.HML_CONFIRMACAO === 'HOMOLOGACAO-BACKEND'
    && e.HML_PERMITIR_ANTERIOR === 'false' && typeof rotulo === 'string' && N.ROTULO.test(rotulo) && !rotulo.endsWith('-retroativo'), 'CONTEXTO_BLOQUEADO');
  return { modo: 'manual', permitirAnterior: false, escopo: 'backend' };
}
function decidirContexto(e) {
  // Sem HML_ESCOPO vale o frontend (o workflow atual não define a variável); qualquer outro valor que não seja
  // frontend ou backend, inclusive vazio, bloqueia.
  const escopo = e.HML_ESCOPO === undefined ? 'frontend' : e.HML_ESCOPO;
  if (escopo === 'backend') return decidirContextoBackend(e);
  if (escopo !== 'frontend') return P.exigir(false, 'CONTEXTO_BLOQUEADO');
  const base = e.GITHUB_REPOSITORY === P.REPO && e.GITHUB_REF === 'refs/heads/main' && e.HML_HABILITADA === 'true';
  if (base && e.GITHUB_EVENT_NAME === 'workflow_dispatch' && e.HML_PUBLICAR === 'true' && e.HML_CONFIRMACAO === 'HOMOLOGACAO'
    && (e.HML_PERMITIR_ANTERIOR === 'true' || e.HML_PERMITIR_ANTERIOR === 'false')) {
    return { modo: 'manual', permitirAnterior: e.HML_PERMITIR_ANTERIOR === 'true' };
  }
  if (base && e.GITHUB_EVENT_NAME === 'workflow_run' && e.GITHUB_RUN_ATTEMPT === '1' && !String(e.HML_ROTULO).endsWith('-retroativo')
    && !e.HML_PERMITIR_ANTERIOR) {
    return { modo: 'automatico', permitirAnterior: false };
  }
  return P.exigir(false, 'CONTEXTO_BLOQUEADO');
}
async function principal() {
  const e = process.env;
  const { permitirAnterior, escopo = 'frontend' } = decidirContexto(e);
  const s3 = criarS3({ bucket: e.HML_BUCKET, conta: e.HML_CONTA, regiao: e.HML_REGIAO, prefixo: prefixoDoEscopo(escopo) });
  const recibo = await publicar({ dir: e.HML_RELEASE_DIR, commit: e.HML_COMMIT, rotulo: e.HML_ROTULO, releaseSha256: e.HML_RELEASE_SHA256, id: `${e.GITHUB_RUN_ID}-${e.GITHUB_RUN_ATTEMPT}`, permitirAnterior, escopo, s3 });
  if (e.GITHUB_STEP_SUMMARY) {
    const texto = escopo === 'backend'
      ? `\nPublicação do backend confirmada: ${recibo.commit}. Recibo de escopo backend validado contra o pedido aprovado.\n`
      : `\nPublicação confirmada pelo agente: ${recibo.commit}. Integridade e HTTP aprovados nos dois componentes.\n`;
    fs.appendFileSync(e.GITHUB_STEP_SUMMARY, texto);
  }
}
if (require.main === module) principal().catch(e => { console.error(`Publicação recusada: ${e.codigo || 'ERRO'}`); process.exitCode = 1; });
module.exports = { publicar, decidirContexto, prefixoDoEscopo };
