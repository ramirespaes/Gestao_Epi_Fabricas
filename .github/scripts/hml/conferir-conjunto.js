'use strict';

/**
 * Conferência conjunta das releases de homologação do mesmo commit: frontend (Portal e Painel) e backend.
 *
 * Só confere e identifica. Não entrega pedido, não instala e não decide a compatibilidade com o banco: essa decisão
 * continua no servidor, no gate de compatibilidade existente, com o estado observado. Nenhuma migration é executada.
 *
 * Cada release é validada pelo validador oficial do seu escopo (protocolo.conferirRelease e os verificadores dos dois
 * empacotadores); aqui se acrescenta o que só o par permite ver: mesmo commit, mesmo rótulo, nenhuma retroativa e a
 * lista de migrations declarada igual à do pacote. O identificador do conjunto amarra os SHA-256 dos dois release.json.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '..', '..', '..');
const P = require(path.join(RAIZ, 'deploy/hml/cd/protocolo'));
const { verificarRelease } = require('./gerar-release');

const SHA_COMPLETO = /^[0-9a-f]{40}$/;
const HEX64 = /^[0-9a-f]{64}$/;
const ROTULO = /^hml-\d{8}T\d{6}-[0-9a-f]{7}(-retroativo)?$/;
const MIGRATION_NO_MANIFESTO = /^([0-9a-f]{64}) {2}migrations\/([^/]+\.sql)$/;

const recusa = (codigo, mensagem = codigo) => Object.assign(new Error(mensagem), { codigo });
const exigir = (ok, codigo, mensagem) => { if (!ok) throw recusa(codigo, mensagem); };
const sha256 = (dados) => crypto.createHash('sha256').update(dados).digest('hex');
const texto = (v) => typeof v === 'string' && v.trim() !== '';

function identificadorDoConjunto({ commit, rotulo, frontendSha256, backendSha256 }) {
  exigir(SHA_COMPLETO.test(commit || '') && ROTULO.test(rotulo || '') && HEX64.test(frontendSha256 || '') && HEX64.test(backendSha256 || ''), 'IDENTIDADE_INVALIDA');
  return sha256(`safework-hml-conjunto-v1\n${commit}\n${rotulo}\nfrontend ${frontendSha256}\nbackend ${backendSha256}\n`);
}

// A seção do backend declara as migrations; o manifesto lista o que de fato está no pacote. Têm de coincidir.
function conferirMigrations(backendDir, secao) {
  const declaradas = Array.isArray(secao.migrations) ? secao.migrations : [];
  const noPacote = new Map();
  for (const linha of fs.readFileSync(path.join(backendDir, 'manifesto-backend.sha256'), 'utf8').split('\n')) {
    const m = MIGRATION_NO_MANIFESTO.exec(linha);
    if (m) noPacote.set(m[2], m[1]);
  }
  const iguais = declaradas.length > 0 && declaradas.length === noPacote.size
    && declaradas.every((m) => m !== null && typeof m === 'object' && noPacote.get(m.nome) === m.sha256)
    && new Set(declaradas.map((m) => m.nome)).size === declaradas.length;
  exigir(iguais, 'CONJUNTO_MIGRATIONS_DIVERGENTES', 'as migrations declaradas no release.json do backend diferem das que estão no pacote');
  return declaradas.length;
}

function conferirConjunto({ frontendDir, backendDir, commit, rotulo, frontendSha256 } = {}) {
  exigir(texto(frontendDir) && texto(backendDir) && SHA_COMPLETO.test(commit || '') && ROTULO.test(rotulo || '') && HEX64.test(frontendSha256 || ''), 'IDENTIDADE_INVALIDA');
  exigir(!rotulo.endsWith('-retroativo'), 'CONJUNTO_RETROATIVO', 'release retroativa não forma conjunto: o backend só acompanha a cabeça atual da main');

  const frontend = P.conferirRelease({ dir: frontendDir, commit, rotulo, releaseSha256: frontendSha256 });
  try { verificarRelease(frontendDir); } catch (falha) { throw recusa(falha.codigo || 'RELEASE_DIVERGENTE', falha.message); }

  let backendSha256;
  try { backendSha256 = sha256(fs.readFileSync(path.join(backendDir, 'release.json'))); } catch { throw recusa('RELEASE_BACKEND_ILEGIVEL'); }
  const backend = P.conferirRelease({ dir: backendDir, commit, rotulo, releaseSha256: backendSha256, escopo: 'backend' });

  const f = frontend.release;
  const b = backend.release;
  exigir(f.commit === b.commit && f.commit === commit && f.rotulo === b.rotulo && f.rotulo === rotulo, 'COMMIT_DIVERGENTE');
  exigir(f.atual === true && b.atual === true, 'CONJUNTO_RETROATIVO');
  const migrations = conferirMigrations(backendDir, b.backend);

  return {
    versao: 1,
    // Identidade de releases PREPARADAS. Vale para os três componentes: este registro não diz nada sobre o que foi
    // entregue ou instalado; isso só o recibo de cada publicação comprova.
    tipo: 'RELEASES_PREPARADAS',
    comprovaPublicacao: false,
    comprovaInstalacao: false,
    commit,
    rotulo,
    frontend: { releaseSha256: frontendSha256, portal: { manifestoSha256: f.portal.manifestoSha256 }, painel: { manifestoSha256: f.painel.manifestoSha256 } },
    backend: { releaseSha256: backendSha256, manifestoSha256: b.backend.manifestoSha256, migrations },
    conjuntoSha256: identificadorDoConjunto({ commit, rotulo, frontendSha256, backendSha256 }),
  };
}

function principal(e = process.env) {
  exigir(texto(e.HML_CONJUNTO_SAIDA) && path.isAbsolute(e.HML_CONJUNTO_SAIDA), 'IDENTIDADE_INVALIDA');
  const conjunto = conferirConjunto({ frontendDir: e.HML_FRONTEND_DIR, backendDir: e.HML_RELEASE_BACKEND_DIR, commit: e.HML_COMMIT, rotulo: e.HML_ROTULO, frontendSha256: e.HML_RELEASE_SHA256 });
  fs.writeFileSync(e.HML_CONJUNTO_SAIDA, `${JSON.stringify(conjunto, null, 2)}\n`, { flag: 'wx' });
  if (e.GITHUB_OUTPUT) fs.appendFileSync(e.GITHUB_OUTPUT, `conjunto_sha256=${conjunto.conjuntoSha256}\n`);
  if (e.GITHUB_STEP_SUMMARY) {
    fs.appendFileSync(e.GITHUB_STEP_SUMMARY, [
      '', '## Conjunto do mesmo commit (frontend e backend)',
      '- Status: `PREPARACAO_CONJUNTO_CONFERIDA` — conferência concluída; não indica o armazenamento do artefato.',
      '- O armazenamento é o passo seguinte: se ele falhar, o resumo traz `PREPARACAO_CONJUNTO_FALHOU`, que prevalece.',
      `- Commit: \`${conjunto.commit}\``,
      `- Release: \`${conjunto.rotulo}\``,
      `- release.json do frontend (Portal e Painel): \`${conjunto.frontend.releaseSha256}\``,
      `- release.json do backend: \`${conjunto.backend.releaseSha256}\``,
      `- Identificador do conjunto: \`${conjunto.conjuntoSha256}\``,
      `- Backend: preparado e conferido (${conjunto.backend.migrations} migrations declaradas); **NÃO publicado** por este workflow.`,
      '- Este registro identifica releases preparadas: não comprova instalação nem publicação de nenhum componente.',
      '- A publicação desta execução, se aprovada, alcança somente Portal e Painel e tem resultado próprio no job de publicação.', '',
    ].join('\n'));
  }
  return conjunto;
}

if (require.main === module) {
  try { principal(); } catch (falha) { console.error(`PREPARACAO_CONJUNTO_FALHOU: conjunto recusado (${falha.codigo || 'ERRO'})`); process.exitCode = 1; }
}

module.exports = { conferirConjunto, identificadorDoConjunto, principal };
