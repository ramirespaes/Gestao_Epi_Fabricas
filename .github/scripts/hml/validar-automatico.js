'use strict';

/**
 * Validação do disparo automático da homologação (deploy-hml.yml, evento
 * workflow_run do CI). Funções puras sobre fatos coletados pelo workflow.
 *
 * O payload do evento nunca é a única fonte: o workflow consulta a API para a
 * mesma execução do CI e os dois precisam coincidir em todos os campos.
 * Fail-closed: qualquer fato ausente ou divergente recusa.
 */

const fs = require('node:fs');
const { SHA_COMPLETO, CI_CAMINHO, RecusaHml } = require('./validar-commit');

const REPOSITORIO = 'ramirespaes/Gestao_Epi_Fabricas';
const CAMPOS = ['id', 'name', 'path', 'event', 'head_branch', 'head_sha', 'status', 'conclusion', 'head_repository'];
const TITULO = (commit) => `HML automatico ${commit}`;

function normalizar(run) {
  if (!run || typeof run !== 'object') return null;
  const repo = run.head_repository && typeof run.head_repository === 'object' ? run.head_repository.full_name : run.head_repository;
  return {
    id: run.id,
    name: run.name,
    path: typeof run.path === 'string' ? run.path.split('@')[0] : run.path,
    event: run.event,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    status: run.status,
    conclusion: run.conclusion,
    head_repository: repo,
  };
}

function conferirCi(run, rotulo) {
  const r = normalizar(run);
  if (!r) throw new RecusaHml('EVENTO_INVALIDO', `${rotulo} ausente`);
  if (typeof r.head_sha !== 'string' || !SHA_COMPLETO.test(r.head_sha)) throw new RecusaHml('COMMIT_INVALIDO', `${rotulo}: head_sha inválido`);
  if (!Number.isSafeInteger(r.id) || r.id <= 0) throw new RecusaHml('EVENTO_INVALIDO', `${rotulo}: id da execução inválido`);
  if (r.name !== 'CI' || r.path !== CI_CAMINHO) throw new RecusaHml('CI_DIFERENTE', `${rotulo}: não é o workflow CI da main`);
  if (r.event !== 'push') throw new RecusaHml('EVENTO_INDEVIDO', `${rotulo}: o CI não veio de push (${String(r.event)})`);
  if (r.head_branch !== 'main') throw new RecusaHml('BRANCH_INDEVIDA', `${rotulo}: o CI não é da main`);
  if (r.head_repository !== REPOSITORIO) throw new RecusaHml('REPOSITORIO_INDEVIDO', `${rotulo}: o CI não é do repositório oficial`);
  if (r.status !== 'completed') throw new RecusaHml('CI_NAO_CONCLUIDO', `${rotulo}: o CI não foi concluído`);
  if (r.conclusion !== 'success') throw new RecusaHml('CI_NAO_VERDE', `${rotulo}: o CI não terminou com sucesso (${String(r.conclusion)})`);
  return r;
}

/**
 * fatos: { repositorio, evento (payload), api (execução do CI consultada na API),
 *          cabecaMain, execucaoAtual: { id, tentativa }, execucoesDeploy }
 */
function validarEventoAutomatico(fatos) {
  if (!fatos || typeof fatos !== 'object') throw new RecusaHml('FATO_INVALIDO', 'fatos ausentes');
  const { repositorio, evento, api, cabecaMain, execucaoAtual, execucoesDeploy } = fatos;
  if (repositorio !== REPOSITORIO) throw new RecusaHml('REPOSITORIO_INDEVIDO', 'o workflow não está rodando no repositório oficial');
  const doEvento = conferirCi(evento, 'payload do evento');
  const daApi = conferirCi(api, 'consulta à API');
  for (const campo of CAMPOS) {
    if (doEvento[campo] !== daApi[campo]) throw new RecusaHml('EVENTO_DIVERGENTE', `payload e API divergem em ${campo}`);
  }
  if (typeof cabecaMain !== 'string' || !SHA_COMPLETO.test(cabecaMain)) throw new RecusaHml('FATO_INVALIDO', 'cabeça da main não identificada');
  if (doEvento.head_sha !== cabecaMain) {
    throw new RecusaHml('COMMIT_SUBSTITUIDO', `a main já avançou para ${cabecaMain.slice(0, 7)}; o CI aprovou ${doEvento.head_sha.slice(0, 7)} e o fluxo automático só publica a cabeça atual`);
  }
  if (!execucaoAtual || execucaoAtual.tentativa !== 1) {
    throw new RecusaHml('REEXECUCAO_BLOQUEADA', 'o fluxo automático não aceita nova tentativa da mesma execução; use o disparo manual');
  }
  if (!Array.isArray(execucoesDeploy)) throw new RecusaHml('FATO_INVALIDO', 'execuções anteriores do CD não consultadas');
  const titulo = TITULO(doEvento.head_sha);
  const duplicada = execucoesDeploy.find((e) => e && typeof e === 'object' && e.id !== execucaoAtual.id && e.display_title === titulo
    && (e.status !== 'completed' || e.conclusion === 'success'));
  if (duplicada) throw new RecusaHml('PUBLICACAO_DUPLICADA', `já existe execução do CD para ${doEvento.head_sha.slice(0, 7)} (${duplicada.status}/${duplicada.conclusion})`);
  return { ok: true, commit: doEvento.head_sha, ciRunId: doEvento.id };
}

/**
 * Reconferência no momento da publicação, depois da aprovação humana: a main
 * não pode ter avançado enquanto a aprovação esperava. Release retroativa
 * (rollback manual explícito) não depende da cabeça.
 */
function conferirAtualidade({ commit, cabecaAtual, exigirAtual }) {
  if (typeof commit !== 'string' || !SHA_COMPLETO.test(commit)) throw new RecusaHml('COMMIT_INVALIDO', 'commit inválido');
  if (typeof cabecaAtual !== 'string' || !SHA_COMPLETO.test(cabecaAtual)) throw new RecusaHml('FATO_INVALIDO', 'cabeça atual da main não identificada');
  if (exigirAtual !== true && exigirAtual !== false) throw new RecusaHml('FATO_INVALIDO', 'modo de atualidade indefinido');
  if (exigirAtual && commit !== cabecaAtual) {
    throw new RecusaHml('COMMIT_SUBSTITUIDO', `a main avançou para ${cabecaAtual.slice(0, 7)} durante a espera; publicação do commit ${commit.slice(0, 7)} recusada`);
  }
  return { ok: true };
}

if (require.main === module) {
  const a = process.argv.slice(2);
  try {
    if (a.length === 2 && a[0] === '--fatos') {
      const r = validarEventoAutomatico(JSON.parse(fs.readFileSync(a[1], 'utf8')));
      console.log(`Disparo automático aceito: ${r.commit} (CI ${r.ciRunId})`);
    } else if (a.length === 1 && a[0] === '--atualidade') {
      const e = process.env;
      const exigirAtual = e.HML_EXIGIR_ATUAL === 'true' ? true : e.HML_EXIGIR_ATUAL === 'false' ? false : undefined;
      conferirAtualidade({ commit: e.HML_COMMIT, cabecaAtual: e.HML_CABECA_ATUAL, exigirAtual });
      console.log('Atualidade confirmada: a main não avançou durante a espera');
    } else {
      throw new RecusaHml('USO', 'uso: validar-automatico.js --fatos <arquivo.json> | --atualidade');
    }
  } catch (erro) {
    console.error(`Homologação recusada (${erro.codigo || 'ERRO'}): ${erro.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validarEventoAutomatico, conferirAtualidade, conferirCi, normalizar, TITULO, REPOSITORIO };
