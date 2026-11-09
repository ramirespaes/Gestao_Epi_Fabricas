'use strict';
const fs = require('node:fs');
const N = require('../instalador/nucleo');
const P = require('./protocolo');
const { criarS3 } = require('./s3');
async function publicar({ dir, commit, rotulo, releaseSha256, id, permitirAnterior = false, s3, agora = Date.now, esperar = ms => new Promise(r => setTimeout(r, ms)), tentativas = 60 }) {
  const blob = P.empacotar(dir, { commit, rotulo, releaseSha256 });
  const t = agora();
  const pedido = P.validarPedido({ versao: 1, repositorio: P.REPO, id, commit, rotulo, releaseSha256, blobSha256: N.sha256(blob), permitirAnterior, criadoEm: new Date(t).toISOString(), expiraEm: new Date(t + 8 * 60000).toISOString() }, t);
  // O pedido é a autorização; só existe depois de o conteúdo estar completo.
  await s3.put(`hml/blobs/${id}.json`, blob);
  await s3.put(`hml/pedidos/${id}.json`, Buffer.from(JSON.stringify(pedido)));
  for (let i = 0; i < tentativas; i++) {
    const b = await s3.get(`hml/recibos/${id}.json`);
    if (b !== null) return P.validarRecibo(P.json(b), pedido);
    await esperar(10000);
  }
  throw Object.assign(new Error('SEM_RECIBO_CONCLUSIVO'), { codigo: 'SEM_RECIBO_CONCLUSIVO' });
}
async function principal() {
  const e = process.env;
  P.exigir(e.GITHUB_REPOSITORY === P.REPO && e.GITHUB_REF === 'refs/heads/main' && e.GITHUB_EVENT_NAME === 'workflow_dispatch' && e.HML_PUBLICAR === 'true' && e.HML_HABILITADA === 'true' && e.HML_CONFIRMACAO === 'HOMOLOGACAO', 'CONTEXTO_BLOQUEADO');
  P.exigir(e.HML_PERMITIR_ANTERIOR === 'true' || e.HML_PERMITIR_ANTERIOR === 'false', 'CONTEXTO_BLOQUEADO');
  const s3 = criarS3({ bucket: e.HML_BUCKET, conta: e.HML_CONTA, regiao: e.HML_REGIAO });
  const recibo = await publicar({ dir: e.HML_RELEASE_DIR, commit: e.HML_COMMIT, rotulo: e.HML_ROTULO, releaseSha256: e.HML_RELEASE_SHA256, id: `${e.GITHUB_RUN_ID}-${e.GITHUB_RUN_ATTEMPT}`, permitirAnterior: e.HML_PERMITIR_ANTERIOR === 'true', s3 });
  if (e.GITHUB_STEP_SUMMARY) fs.appendFileSync(e.GITHUB_STEP_SUMMARY, `\nPublicação confirmada pelo agente: ${recibo.commit}. Integridade e HTTP aprovados nos dois componentes.\n`);
}
if (require.main === module) principal().catch(e => { console.error(`Publicação recusada: ${e.codigo || 'ERRO'}`); process.exitCode = 1; });
module.exports = { publicar };
