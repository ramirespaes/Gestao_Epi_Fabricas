'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { validarEventoAutomatico, conferirAtualidade, TITULO, REPOSITORIO } = require('../validar-automatico');
const { validarCommit } = require('../validar-commit');

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const SCRIPT = path.resolve(__dirname, '..', 'validar-automatico.js');

const ci = (extra = {}) => ({
  id: 1001, name: 'CI', path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main', head_sha: A,
  status: 'completed', conclusion: 'success', head_repository: REPOSITORIO, ...extra,
});
const fatos = (extra = {}) => ({
  repositorio: REPOSITORIO,
  evento: ci(),
  api: ci({ path: '.github/workflows/ci.yml@refs/heads/main' }),
  cabecaMain: A,
  execucaoAtual: { id: 2002, tentativa: 1 },
  execucoesDeploy: [],
  ...extra,
});
const recusa = (f, codigo) => assert.throws(() => validarEventoAutomatico(f), (e) => e.codigo === codigo, `esperado ${codigo}`);

describe('validarEventoAutomatico — aceita somente CI verde de push na main, na cabeça atual', () => {
  test('positivo: CI de push na main concluído com sucesso, payload e API coerentes', () => {
    assert.deepEqual(validarEventoAutomatico(fatos()), { ok: true, commit: A, ciRunId: 1001 });
  });

  test('positivo: execuções anteriores de outros commits, falhas e canceladas não bloqueiam', () => {
    const anteriores = [
      { id: 1, display_title: TITULO(B), status: 'completed', conclusion: 'success' },
      { id: 2, display_title: TITULO(A), status: 'completed', conclusion: 'failure' },
      { id: 3, display_title: TITULO(A), status: 'completed', conclusion: 'cancelled' },
      { id: 4, display_title: `HML manual ${A}`, status: 'completed', conclusion: 'success' },
    ];
    assert.equal(validarEventoAutomatico(fatos({ execucoesDeploy: anteriores })).commit, A);
  });

  test('CI de pull_request é recusado, mesmo com branch main e conclusão verde', () => {
    recusa(fatos({ evento: ci({ event: 'pull_request' }), api: ci({ event: 'pull_request' }) }), 'EVENTO_INDEVIDO');
  });

  test('CI de fork (head_repository diferente) é recusado', () => {
    recusa(fatos({ evento: ci({ head_repository: 'intruso/Gestao_Epi_Fabricas' }), api: ci({ head_repository: 'intruso/Gestao_Epi_Fabricas' }) }), 'REPOSITORIO_INDEVIDO');
  });

  test('CI reprovado, cancelado, ignorado, com timeout ou sem conclusão é recusado', () => {
    for (const conclusion of ['failure', 'cancelled', 'skipped', 'timed_out', 'neutral', 'action_required', null, undefined]) {
      recusa(fatos({ evento: ci({ conclusion }), api: ci({ conclusion }) }), 'CI_NAO_VERDE');
    }
  });

  test('CI ainda em andamento é recusado', () => {
    for (const status of ['in_progress', 'queued', 'waiting']) recusa(fatos({ evento: ci({ status }), api: ci({ status }) }), 'CI_NAO_CONCLUIDO');
  });

  test('outro workflow, outro caminho ou outra branch não valem', () => {
    recusa(fatos({ evento: ci({ name: 'Ensaio D12' }), api: ci({ name: 'Ensaio D12' }) }), 'CI_DIFERENTE');
    recusa(fatos({ evento: ci({ path: '.github/workflows/ensaio-d12-sharp.yml' }), api: ci({ path: '.github/workflows/ensaio-d12-sharp.yml' }) }), 'CI_DIFERENTE');
    recusa(fatos({ evento: ci({ head_branch: 'feature/x' }), api: ci({ head_branch: 'feature/x' }) }), 'BRANCH_INDEVIDA');
  });

  test('evento falsificado: payload verde, mas a API diz que o CI falhou, foi de PR ou é de outro commit', () => {
    recusa(fatos({ api: ci({ conclusion: 'failure' }) }), 'CI_NAO_VERDE');
    recusa(fatos({ api: ci({ event: 'pull_request' }) }), 'EVENTO_INDEVIDO');
    recusa(fatos({ api: ci({ head_sha: B }) }), 'EVENTO_DIVERGENTE');
    recusa(fatos({ api: ci({ id: 9999 }) }), 'EVENTO_DIVERGENTE');
  });

  test('evento falsificado: consulta à API ausente ou payload malformado', () => {
    recusa(fatos({ api: null }), 'EVENTO_INVALIDO');
    recusa(fatos({ evento: undefined }), 'EVENTO_INVALIDO');
    recusa(fatos({ evento: ci({ head_sha: 'ABC' }), api: ci({ head_sha: 'ABC' }) }), 'COMMIT_INVALIDO');
    recusa(fatos({ evento: ci({ head_sha: A.toUpperCase() }), api: ci({ head_sha: A.toUpperCase() }) }), 'COMMIT_INVALIDO');
    recusa(fatos({ evento: ci({ id: '1001' }), api: ci({ id: '1001' }) }), 'EVENTO_INVALIDO');
    recusa(null, 'FATO_INVALIDO');
  });

  test('o workflow precisa estar no repositório oficial', () => {
    recusa(fatos({ repositorio: 'intruso/Gestao_Epi_Fabricas' }), 'REPOSITORIO_INDEVIDO');
  });

  test('commit antigo: a main já avançou além do commit aprovado pelo CI', () => {
    recusa(fatos({ cabecaMain: B }), 'COMMIT_SUBSTITUIDO');
    recusa(fatos({ cabecaMain: undefined }), 'FATO_INVALIDO');
    recusa(fatos({ cabecaMain: 'curto' }), 'FATO_INVALIDO');
  });

  test('publicação duplicada: já existe execução em andamento, aguardando aprovação ou concluída com sucesso para o mesmo commit', () => {
    for (const [status, conclusion] of [['in_progress', null], ['queued', null], ['waiting', null], ['pending', null], ['completed', 'success']]) {
      recusa(fatos({ execucoesDeploy: [{ id: 77, display_title: TITULO(A), status, conclusion }] }), 'PUBLICACAO_DUPLICADA');
    }
  });

  test('a própria execução não conta como duplicata de si mesma', () => {
    assert.equal(validarEventoAutomatico(fatos({ execucoesDeploy: [{ id: 2002, display_title: TITULO(A), status: 'in_progress', conclusion: null }] })).commit, A);
  });

  test('execuções anteriores não consultadas (lista ausente) recusam', () => {
    recusa(fatos({ execucoesDeploy: undefined }), 'FATO_INVALIDO');
    recusa(fatos({ execucoesDeploy: 'x' }), 'FATO_INVALIDO');
  });

  test('nova tentativa da mesma execução do CD não é aceita no fluxo automático', () => {
    recusa(fatos({ execucaoAtual: { id: 2002, tentativa: 2 } }), 'REEXECUCAO_BLOQUEADA');
    recusa(fatos({ execucaoAtual: { id: 2002, tentativa: null } }), 'REEXECUCAO_BLOQUEADA');
    recusa(fatos({ execucaoAtual: undefined }), 'REEXECUCAO_BLOQUEADA');
  });
});

describe('corrida entre commits', () => {
  test('dois CIs verdes em sequência: só o da cabeça atual da main é aceito', () => {
    const emB = { cabecaMain: B };
    recusa(fatos(emB), 'COMMIT_SUBSTITUIDO');
    const paraB = fatos({ cabecaMain: B, evento: ci({ id: 1002, head_sha: B }), api: ci({ id: 1002, head_sha: B }) });
    assert.equal(validarEventoAutomatico(paraB).commit, B);
  });

  test('a decisão final de commit (validar-commit) continua recusando commit antigo sem permitir_commit_anterior', () => {
    const execucoesCi = [{ head_sha: A, path: '.github/workflows/ci.yml', event: 'push', head_branch: 'main', status: 'completed', conclusion: 'success' }];
    assert.throws(() => validarCommit({ commit: A, cabecaMain: B, ancestral: true, execucoesCi, permitirAnterior: false }), (e) => e.codigo === 'COMMIT_ANTERIOR');
    assert.equal(validarCommit({ commit: A, cabecaMain: A, ancestral: true, execucoesCi, permitirAnterior: false, agora: Date.UTC(2026, 10, 9) }).atual, true);
  });

  test('conferirAtualidade: depois da aprovação, a main não pode ter avançado', () => {
    assert.deepEqual(conferirAtualidade({ commit: A, cabecaAtual: A, exigirAtual: true }), { ok: true });
    assert.throws(() => conferirAtualidade({ commit: A, cabecaAtual: B, exigirAtual: true }), (e) => e.codigo === 'COMMIT_SUBSTITUIDO');
  });

  test('conferirAtualidade: rollback manual explícito (retroativo) não depende da cabeça, mas dados inválidos recusam', () => {
    assert.deepEqual(conferirAtualidade({ commit: A, cabecaAtual: B, exigirAtual: false }), { ok: true });
    for (const ruim of [
      { commit: 'x', cabecaAtual: A, exigirAtual: true }, { commit: A, cabecaAtual: '', exigirAtual: true },
      { commit: A, cabecaAtual: A, exigirAtual: undefined }, { commit: A, cabecaAtual: A, exigirAtual: 'true' },
    ]) assert.throws(() => conferirAtualidade(ruim), (e) => ['COMMIT_INVALIDO', 'FATO_INVALIDO'].includes(e.codigo));
  });
});

describe('linha de comando (como o workflow a executa)', () => {
  const executar = (args, env = {}) => spawnSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const gravar = (f) => { const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'hml-auto-')); const arq = path.join(dir, 'fatos.json'); fs.writeFileSync(arq, JSON.stringify(f)); return { dir, arq }; };

  test('--fatos válido sai com 0; inválido sai com 1 e informa o código sem expor dados', () => {
    const ok = gravar(fatos());
    const ruim = gravar(fatos({ cabecaMain: B }));
    try {
      const r1 = executar(['--fatos', ok.arq]);
      assert.equal(r1.status, 0);
      assert.match(r1.stdout, /Disparo automático aceito/);
      const r2 = executar(['--fatos', ruim.arq]);
      assert.equal(r2.status, 1);
      assert.match(r2.stderr, /COMMIT_SUBSTITUIDO/);
    } finally { fs.rmSync(ok.dir, { recursive: true, force: true }); fs.rmSync(ruim.dir, { recursive: true, force: true }); }
  });

  test('uso incorreto, arquivo ausente e JSON quebrado falham fechado', () => {
    assert.equal(executar([]).status, 1);
    assert.equal(executar(['--fatos', '/nao/existe.json']).status, 1);
    const q = gravar({}); fs.writeFileSync(q.arq, '{quebrado');
    try { assert.equal(executar(['--fatos', q.arq]).status, 1); } finally { fs.rmSync(q.dir, { recursive: true, force: true }); }
  });

  test('--atualidade: cabeça igual passa; cabeça diferente, vazia ou modo indefinido recusam', () => {
    assert.equal(executar(['--atualidade'], { HML_COMMIT: A, HML_CABECA_ATUAL: A, HML_EXIGIR_ATUAL: 'true' }).status, 0);
    const avancou = executar(['--atualidade'], { HML_COMMIT: A, HML_CABECA_ATUAL: B, HML_EXIGIR_ATUAL: 'true' });
    assert.equal(avancou.status, 1);
    assert.match(avancou.stderr, /COMMIT_SUBSTITUIDO/);
    assert.equal(executar(['--atualidade'], { HML_COMMIT: A, HML_CABECA_ATUAL: '', HML_EXIGIR_ATUAL: 'true' }).status, 1);
    assert.equal(executar(['--atualidade'], { HML_COMMIT: A, HML_CABECA_ATUAL: A }).status, 1);
    assert.equal(executar(['--atualidade'], { HML_COMMIT: A, HML_CABECA_ATUAL: B, HML_EXIGIR_ATUAL: 'false' }).status, 0);
  });
});
