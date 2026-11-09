'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TITULO } = require('../validar-automatico');

/**
 * Contrato estático do disparo automático (CI verde → aprovação → publicação).
 * Estes testes leem o YAML; não provam o comportamento no GitHub, que só o
 * fluxo real CI → CD → aprovação → AWS HML comprova.
 */

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const yaml = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'deploy-hml.yml'), 'utf8');
const [antes, publicar] = yaml.split('\n  publicar:\n');
const validar = antes.match(/^ {2}validar:\n([\s\S]*?)^ {2}empacotar:/m)[1];
const empacotar = antes.match(/^ {2}empacotar:\n([\s\S]*)$/m)[1];

const SEM_COMENTARIO = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');

describe('deploy-hml.yml — disparo automático após o CI', () => {
  test('o job validar só aceita workflow_run de push na main, verde, do repositório oficial, ou o disparo manual', () => {
    const cond = validar.match(/^ {4}if: \$\{\{ (.*) \}\}$/m)[1];
    for (const parte of [
      "github.event_name == 'workflow_dispatch'", "github.event_name == 'workflow_run'",
      "github.event.workflow_run.event == 'push'", "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.head_branch == 'main'", 'github.event.workflow_run.head_repository.full_name == github.repository',
    ]) assert.ok(cond.includes(parte), parte);
  });

  test('o commit do fluxo automático é o head_sha do CI; o manual continua vindo da entrada', () => {
    assert.match(validar, /COMMIT: \$\{\{ github\.event_name == 'workflow_run' && github\.event\.workflow_run\.head_sha \|\| inputs\.commit \}\}/);
    assert.match(empacotar, /ref: \$\{\{ needs\.validar\.outputs\.commit \}\}/);
    assert.match(publicar, /HML_COMMIT: \$\{\{ needs\.validar\.outputs\.commit \}\}/);
  });

  test('confirmação literal e formato do SHA continuam: obrigatórios no manual, substituídos pelo CI verde no automático', () => {
    const passo1 = validar.match(/- name: Confirmação literal[\s\S]*?\n {6}- name:/)[0];
    assert.match(passo1, /workflow_dispatch\) \[ "\$CONFIRMACAO" = "HOMOLOGACAO" \] \|\| \{[^}]*exit 1; \} ;;/);
    assert.match(passo1, /workflow_run\) ;;/);
    assert.match(passo1, /\*\) echo "evento não previsto[^\n]*exit 1 ;;/);
    assert.match(passo1, /\[ "\$REF_DO_WORKFLOW" = "refs\/heads\/main" \] \|\| \{[^}]*exit 1; \}/);
    assert.match(passo1, /grep -Eq '\^\[0-9a-f\]\{40\}\$'/);
    assert.match(yaml, /confirmacao:\n\s+description:[^\n]*\n\s+required: true/);
  });

  test('o payload do evento chega por env (nunca interpolado em run) e é confrontado com a API', () => {
    for (const campo of ['id', 'name', 'path', 'event', 'head_branch', 'head_sha', 'status', 'conclusion', 'head_repository.full_name']) {
      assert.ok(validar.includes(`\${{ github.event.workflow_run.${campo} }}`), campo);
    }
    assert.match(validar, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/runs\/\$\{CI_ID\}"/);
    assert.match(validar, /actions\/workflows\/deploy-hml\.yml\/runs\?per_page=100/);
    assert.match(validar, /grep -Eq '\^\[0-9\]\{1,20\}\$'/, 'id do CI validado antes de entrar na URL');
    for (const bloco of SEM_COMENTARIO(yaml).split(/^\s*run:/m).slice(1)) {
      const corpo = bloco.split(/\n\s+- name:|\n\s+uses:|\n {2}\w+:\n/)[0];
      assert.doesNotMatch(corpo, /\$\{\{\s*(?:inputs|github\.event|needs|vars)\./);
    }
  });

  test('a validação automática roda só no workflow_run, antes da decisão de commit e do empacotamento', () => {
    const passos = [...validar.matchAll(/^ {6}- name: ([^\n]+)/gm)].map((m) => m[1]);
    const iAuto = passos.findIndex((p) => p.startsWith('Validar o disparo automático'));
    const iDecisao = passos.findIndex((p) => p.startsWith('Decidir'));
    assert.ok(iAuto > 0 && iAuto < iDecisao, 'validação automática antes da decisão');
    assert.match(validar, /name: Validar o disparo automático[^\n]*\n\s+if: \$\{\{ github\.event_name == 'workflow_run' \}\}\n\s+run: node \.github\/scripts\/hml\/validar-automatico\.js --fatos "\$RUNNER_TEMP\/fatos-automaticos\.json"/);
    assert.match(empacotar, /needs: validar/);
    assert.doesNotMatch(SEM_COMENTARIO(antes), /continue-on-error|if:\s*always\(\)|!cancelled/);
  });

  test('o título da execução casa com o que o script usa para detectar duplicidade', () => {
    const modelo = yaml.match(/^run-name: .*format\('(HML automatico \{0\})', github\.event\.workflow_run\.head_sha\)/m);
    assert.ok(modelo, 'run-name automático');
    assert.equal(modelo[1].replace('{0}', 'S'), TITULO('S'));
    assert.match(yaml, /format\('HML manual \{0\}', inputs\.commit\)/);
  });

  test('a publicação continua atrás do environment homologacao e dos dois controles, agora para os dois modos', () => {
    assert.match(publicar, /environment: homologacao/);
    assert.match(publicar, /needs: \[validar, empacotar\]/);
    const cond = publicar.match(/^ {4}if: \$\{\{ (.*) \}\}$/m)[1];
    for (const parte of [
      "vars.HML_PUBLICACAO_HABILITADA == 'true'", "github.repository == 'ramirespaes/Gestao_Epi_Fabricas'", "github.ref == 'refs/heads/main'",
      "github.event_name == 'workflow_dispatch' && inputs.publicar == true",
      "github.event_name == 'workflow_run'", "github.event.workflow_run.event == 'push'", "github.event.workflow_run.conclusion == 'success'",
      "github.event.workflow_run.head_branch == 'main'", 'github.event.workflow_run.head_sha == needs.validar.outputs.commit',
    ]) assert.ok(cond.includes(parte), parte);
    assert.equal((yaml.match(/id-token: write/g) || []).length, 1);
    assert.equal((yaml.match(/^\s*environment:/gm) || []).length, 1);
  });

  test('o manual não ganha atalho: publicar=true só vale com workflow_dispatch', () => {
    const cond = publicar.match(/^ {4}if: \$\{\{ (.*) \}\}$/m)[1];
    assert.ok(cond.includes("(github.event_name == 'workflow_dispatch' && inputs.publicar == true)"));
    assert.ok(!/\|\| inputs\.publicar|inputs\.publicar == true \|\|/.test(cond), 'publicar=true não pode ser alternativa avulsa');
  });

  test('após a aprovação e antes de qualquer credencial, a cabeça da main é reconferida', () => {
    const passos = [...publicar.matchAll(/^ {6}- name: ([^\n]+)/gm)].map((m) => m[1]);
    assert.equal(passos[0].startsWith('Checkout do controlador'), true);
    const iRecheca = passos.findIndex((p) => p.startsWith('Reconferir a cabeça da main'));
    const iConfere = passos.findIndex((p) => p.startsWith('Conferir identidade'));
    const iCred = passos.findIndex((p) => p.startsWith('Credenciais AWS'));
    assert.ok(iRecheca > 0 && iRecheca < iConfere && iConfere < iCred, 'ordem: reconferir, conferir release, credenciais');
    assert.ok(publicar.indexOf('validar-automatico.js --atualidade') < publicar.indexOf('uses: aws-actions/'));
    assert.match(publicar, /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/git\/ref\/heads\/main" --jq \.object\.sha/);
    assert.match(publicar, /HML_EXIGIR_ATUAL: \$\{\{ needs\.validar\.outputs\.atual \}\}/);
  });

  test('os controles herdados continuam: OIDC por environment, allowlist de ações, concorrência serializada e sem escrita', () => {
    assert.match(yaml, /group: deploy-hml\n\s+cancel-in-progress: false/);
    assert.match(publicar, /audience: sts\.amazonaws\.com/);
    assert.match(publicar, /unset-current-credentials: true/);
    assert.deepEqual(SEM_COMENTARIO(yaml).match(/^\s*[\w-]+:\s*write\b/gm).map((l) => l.trim()), ['id-token: write'], 'única escrita: o token OIDC do job publicar');
    assert.doesNotMatch(SEM_COMENTARIO(yaml), /\bsecrets\.|self-hosted|pull_request_target/);
    assert.match(yaml, /^permissions:\n {2}contents: read\n {2}actions: read\n/m);
  });

  test('o fluxo automático não reaproveita o CI para PR: o CI continua sem referências ao CD', () => {
    const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.doesNotMatch(ci, /deploy-hml|workflow_run|^\s*environment:|id-token/m);
    assert.match(ci, /^name: CI$/m, 'o nome do CI é o que o workflow_run observa');
  });
});
