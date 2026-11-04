'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Invariantes do deploy-hml.yml nesta etapa de preparação, lidas como texto:
 * o workflow só valida e gera artefatos, e é incapaz de publicar na AWS
 * independentemente de segredos. Ele não é executado aqui.
 */

const REPO = path.resolve(__dirname, '..', '..', '..', '..');
const CAMINHO = path.join(REPO, '.github', 'workflows', 'deploy-hml.yml');
const texto = fs.readFileSync(CAMINHO, 'utf8');
const semComentarios = texto.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const ACOES_PERMITIDAS = new Set(['actions/checkout@v4', 'actions/setup-node@v4', 'actions/upload-artifact@v4']);

describe('deploy-hml.yml — preparação sem capacidade de publicar', () => {
  test('o único gatilho é workflow_dispatch, com commit e confirmação obrigatórios', () => {
    const gatilhos = semComentarios.match(/^on:\n([\s\S]*?)^\S/m)[1];
    assert.deepEqual([...gatilhos.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]), ['workflow_dispatch']);
    for (const proibido of ['push', 'pull_request', 'pull_request_target', 'schedule', 'workflow_run', 'repository_dispatch', 'release', 'workflow_call']) assert.doesNotMatch(gatilhos, new RegExp(`^ {2}${proibido}:`, 'm'), proibido);
    assert.match(semComentarios, /commit:\n\s+description:[^\n]*\n\s+required: true\n\s+type: string/);
    assert.match(semComentarios, /confirmacao:\n\s+description:[^\n]*\n\s+required: true/);
    assert.match(semComentarios, /permitir_commit_anterior:[\s\S]*?default: false/);
  });

  test('permissões mínimas e globais: só leitura, sem escrita, sem id-token', () => {
    const bloco = semComentarios.match(/^permissions:\n((?: {2}.*\n)+)/m)[1];
    assert.deepEqual(bloco.trim().split('\n').map((l) => l.trim()), ['contents: read', 'actions: read']);
    assert.doesNotMatch(semComentarios, /:\s*write\b/);
    assert.doesNotMatch(semComentarios, /id-token/);
    assert.equal((semComentarios.match(/^\s*permissions:/gm) || []).length, 1, 'nenhum job amplia as permissões');
  });

  test('não usa segredos, environments, variáveis de nuvem nem credenciais', () => {
    for (const proibido of [/\bsecrets\./i, /\bsecrets:/i, /^\s*environment:/m, /\bvars\./, /AWS_/i, /aws-actions/i, /configure-aws/i, /\bLIGHTSAIL/i, /\bSSH_/i, /\bPRIVATE_KEY/i, /\bTOKEN\b(?!.*github\.token)/]) {
      assert.doesNotMatch(semComentarios, proibido, String(proibido));
    }
    assert.equal((semComentarios.match(/\$\{\{\s*github\.token\s*\}\}/g) || []).length, 1, 'único uso de credencial: o token efêmero de leitura da API');
  });

  test('não contém transmissão nem operação de servidor: ssh, scp, sftp, rsync, aws, curl, wget, systemctl, docker, nginx', () => {
    const comandos = semComentarios.split('\n').filter((l) => /^\s*(run:|- run:|[|>]|\s+\S)/.test(l)).join('\n');
    for (const proibido of [/\bssh\b/, /\bscp\b/, /\bsftp\b/, /\brsync\b/, /\baws\b(?! )?(?=\s|$)/, /\bcurl\b/, /\bwget\b/, /\bsystemctl\b/, /\bdocker\b/, /\bnginx\b/, /\bsudo\b/, /\bpsql\b/, /\bnpm (run )?(deploy|migrate)/, /db:migrate(?!:verificar)/, /\bgit (push|commit|tag|checkout -b)\b/, /\bgit merge(?!-base)\b/]) {
      assert.doesNotMatch(comandos, proibido, String(proibido));
    }
  });

  test('só usa as ações oficiais previstas, em versão maior fixada, e nenhuma ação de terceiros', () => {
    const usos = [...semComentarios.matchAll(/^\s*uses:\s*(\S+)/gm)].map((m) => m[1]);
    assert.ok(usos.length >= 4);
    for (const uso of usos) assert.ok(ACOES_PERMITIDAS.has(uso), `ação não prevista: ${uso}`);
  });

  test('todo checkout é sem credenciais persistidas; o job de pacotes usa o commit validado e o de validação lê a main', () => {
    const checkouts = [...semComentarios.matchAll(/uses: actions\/checkout@v4\n((?:\s+.*\n)+?)\s*(?:- name:|$)/g)].map((m) => m[1]);
    assert.equal(checkouts.length, 2);
    for (const c of checkouts) assert.match(c, /persist-credentials: false/);
    assert.match(checkouts[0], /ref: main/);
    assert.match(checkouts[0], /fetch-depth: 0/);
    assert.match(checkouts[1], /ref: \$\{\{ needs\.validar\.outputs\.commit \}\}/);
  });

  test('entradas do usuário nunca são interpoladas em run: passam por env', () => {
    const blocosRun = semComentarios.split(/^\s*run:/m).slice(1).map((b) => b.split(/\n\s*- name:|\n\s*uses:/)[0]);
    for (const bloco of blocosRun) {
      assert.doesNotMatch(bloco, /\$\{\{\s*inputs\./, `interpolação de input em run: ${bloco.slice(0, 60)}`);
      assert.doesNotMatch(bloco, /\$\{\{\s*github\.event\./, 'interpolação de evento em run');
      assert.doesNotMatch(bloco, /\$\{\{\s*needs\./, 'interpolação de saída de job em run');
    }
  });

  test('a decisão de commit usa o script testado, falha fechado e o empacotamento depende dela', () => {
    assert.match(semComentarios, /node \.github\/scripts\/hml\/validar-commit\.js --fatos/);
    assert.match(semComentarios, /git merge-base --is-ancestor/);
    assert.match(semComentarios, /actions\/workflows\/ci\.yml\/runs\?head_sha=/);
    assert.match(semComentarios, /empacotar:\n\s+name:[^\n]*\n\s+needs: validar/);
    assert.doesNotMatch(semComentarios, /continue-on-error|if:\s*always\(\)|if:\s*\$\{\{\s*!cancelled/);
  });

  test('só roda a partir do YAML da main: a primeira etapa de validar recusa qualquer outra ref', () => {
    const primeira = semComentarios.match(/steps:\n\s+- name: ([^\n]+)\n\s+env:\n([\s\S]*?)run: \|\n([\s\S]*?)\n\s+- name:/)[0];
    assert.match(primeira, /REF_DO_WORKFLOW: \$\{\{ github\.ref \}\}/);
    assert.match(primeira, /\[ "\$REF_DO_WORKFLOW" = "refs\/heads\/main" \] \|\| \{[^}]*exit 1; \}/);
  });

  test('o job de pacotes confere que o checkout é o commit validado e que a árvore está limpa, antes de executar qualquer script', () => {
    const empacotar = semComentarios.match(/^ {2}empacotar:\n([\s\S]*)$/m)[1];
    const passos = [...empacotar.matchAll(/^ {6}- name: ([^\n]+)/gm)].map((m) => m[1]);
    assert.ok(passos.indexOf('Conferir que o checkout é exatamente o commit validado') === 1, 'logo depois do checkout');
    assert.match(empacotar, /\[ "\$\(git rev-parse HEAD\)" = "\$COMMIT" \] \|\| \{[^}]*exit 1; \}/);
    assert.match(empacotar, /\[ -z "\$\(git status --porcelain\)" \] \|\| \{[^}]*exit 1; \}/);
  });

  test('os testes de .github/scripts/hml rodam no job validar por glob entre aspas, que o Node 22 aceita (diretório como argumento não funciona)', () => {
    const validar = semComentarios.match(/^ {2}validar:\n([\s\S]*?)^ {2}empacotar:/m)[1];
    assert.match(validar, /run: node --test "\.github\/scripts\/hml\/test\/\*\.test\.js"/);
    assert.doesNotMatch(semComentarios, /node --test \.github\/scripts\/hml\/test\s*$/m);
  });

  test('concorrência serializada sem cancelar execução em andamento', () => {
    assert.match(semComentarios, /concurrency:\n\s+group: deploy-hml\n\s+cancel-in-progress: false/);
  });

  test('gera os dois pacotes por gerar-release.js, confere com sha256sum e guarda só como artefato de retenção curta', () => {
    assert.match(semComentarios, /node \.github\/scripts\/hml\/gerar-release\.js --saida/);
    assert.match(semComentarios, /sha256sum -c --quiet \.\.\/manifesto-portal\.sha256/);
    assert.match(semComentarios, /sha256sum -c --quiet \.\.\/manifesto-painel\.sha256/);
    assert.match(semComentarios, /uses: actions\/upload-artifact@v4/);
    assert.match(semComentarios, /if-no-files-found: error/);
    assert.match(semComentarios, /retention-days: 14/);
    assert.match(semComentarios, /node --test test\/publicacao\.test\.js test\/publicacao-painel\.test\.js/);
  });

  test('dois jobs apenas, validar e empacotar: nenhum job de publicação', () => {
    const jobs = semComentarios.match(/^jobs:\n([\s\S]*)$/m)[1];
    assert.deepEqual([...jobs.matchAll(/^ {2}(\w+):/gm)].map((m) => m[1]), ['validar', 'empacotar']);
  });

  test('o CI existente continua sem deploy e não é acionado por este workflow', () => {
    const ci = fs.readFileSync(path.join(REPO, '.github', 'workflows', 'ci.yml'), 'utf8');
    assert.doesNotMatch(ci, /deploy-hml|workflow_dispatch|aws|ssh/i);
    assert.match(ci, /- name: Homologação - testes dos scripts e do workflow de preparação\n\s+run: node --test "\.github\/scripts\/hml\/test\/\*\.test\.js"\n/, 'o CI executa os testes de .github/scripts/hml');
    assert.match(ci, /\n {2}verificacoes-sem-banco:[\s\S]*?Homologação - testes[\s\S]*?\n {2}integracao-postgresql:/, 'o passo está no job sem banco');
  });
});
