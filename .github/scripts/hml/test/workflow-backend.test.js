'use strict';
// Validação estática do workflow deploy-hml-backend.yml (Etapa 1): disparo só manual, confirmação própria,
// environment próprio, credenciais só no job publicar e nenhuma ligação com o fluxo do frontend.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const RAIZ = path.resolve(__dirname, '../../../..');
const CAMINHO = path.join(RAIZ, '.github', 'workflows', 'deploy-hml-backend.yml');
const FRONT = fs.readFileSync(path.join(RAIZ, '.github', 'workflows', 'deploy-hml.yml'), 'utf8');
const existe = fs.existsSync(CAMINHO);
const yaml = existe ? fs.readFileSync(CAMINHO, 'utf8') : '';
const secaoJobs = existe ? yaml.slice(yaml.indexOf('\njobs:\n')) : '';
const job = (nome) => {
  const ini = secaoJobs.indexOf(`\n  ${nome}:\n`);
  if (ini < 0) return '';
  const resto = secaoJobs.slice(ini + 1);
  const prox = resto.slice(resto.indexOf('\n') + 1).search(/\n  [a-z_]+:\n/);
  return prox < 0 ? resto : resto.slice(0, resto.indexOf('\n') + 1 + prox);
};

describe('deploy-hml-backend.yml: YAML bem formado (um parser real, não só expressões regulares)', () => {
  test('valores simples não contêm ": " (o que quebra o YAML), em nenhuma linha chave: valor fora de blocos', () => {
    const ruins = [];
    let bloco = null;
    for (const [i, linha] of yaml.split('\n').entries()) {
      const indent = linha.length - linha.trimStart().length;
      if (bloco !== null) { if (linha.trim() === '' || indent > bloco) continue; bloco = null; }
      const m = /^(\s*)(?:- )?[A-Za-z_][A-Za-z0-9_-]*: (.+)$/.exec(linha);
      if (!m) continue;
      const valor = m[2].replace(/\s+#.*$/, '').trim(); // comentário no fim da linha é YAML válido
      if (/^[|>]/.test(valor)) { bloco = indent; continue; }
      if (/^["'{\[&*!%@`]/.test(valor) || valor.startsWith('${{')) continue;
      if (/: /.test(valor)) ruins.push(`linha ${i + 1}: ${linha.trim().slice(0, 90)}`);
    }
    assert.deepEqual(ruins, []);
  });
  test('o parser YAML do Ruby (presente nos runners do GitHub) aceita o arquivo e confirma a estrutura', (t) => {
    const r = spawnSync('ruby', ['-ryaml', '-rjson', '-e', 'puts JSON.generate(YAML.safe_load(File.read(ARGV[0]), aliases: false))', CAMINHO], { encoding: 'utf8' });
    if (r.error && r.error.code === 'ENOENT') { t.diagnostic('ruby ausente: só a verificação textual foi feita'); return; }
    assert.equal(r.status, 0, `YAML inválido: ${r.stderr}`);
    const y = JSON.parse(r.stdout);
    const gatilhos = Object.keys(y.on || y.true || {});
    assert.deepEqual(gatilhos, ['workflow_dispatch']);
    assert.deepEqual(Object.keys(y.jobs), ['validar', 'empacotar', 'publicar']);
    assert.equal(y.jobs.publicar.environment, 'homologacao-backend');
    assert.equal(y.jobs.validar.environment, undefined);
    assert.equal(y.jobs.empacotar.environment, undefined);
    assert.equal(y.jobs.publicar.permissions['id-token'], 'write');
    // S8264: nenhuma permissão além de contents: read no nível global; actions: read só onde é usada (validar lista as execuções do CI).
    assert.deepEqual(y.permissions, { contents: 'read' });
    assert.deepEqual(y.jobs.validar.permissions, { contents: 'read', actions: 'read' });
    assert.equal(y.jobs.empacotar.permissions, undefined, 'empacotar herda só contents: read do topo');
    assert.deepEqual(y.jobs.publicar.permissions, { contents: 'read', actions: 'read', 'id-token': 'write' });
    assert.deepEqual(y.jobs.publicar.needs, ['validar', 'empacotar']);
    assert.deepEqual(y.jobs.empacotar.needs, 'validar');
    for (const [nome, job] of Object.entries(y.jobs)) for (const passo of job.steps) assert.ok(passo.name && (passo.uses || passo.run), `${nome}: passo sem nome ou sem ação`);
  });
});

describe('deploy-hml-backend.yml: existência e disparo', () => {
  test('o workflow existe', () => assert.ok(existe, 'deploy/workflow deploy-hml-backend.yml ainda não existe (RED esperado)'));
  test('só workflow_dispatch: nenhum disparo automático, de PR, push, agenda ou de outro workflow', () => {
    assert.match(yaml, /^on:\n  workflow_dispatch:\n/m);
    const on = yaml.slice(yaml.indexOf('\non:\n'), yaml.indexOf('\npermissions:'));
    assert.doesNotMatch(on, /workflow_run|\bpush:|pull_request|schedule|repository_dispatch|workflow_call|release:|\bissues:/);
    assert.equal((on.match(/^  [a-z_]+:/gm) || []).length, 1, 'um único gatilho');
  });
  test('entradas: commit e confirmação obrigatórios; publicar opcional, falso por padrão; sem opção de commit anterior', () => {
    assert.match(yaml, /commit:\n\s+description:[^\n]*\n\s+required: true\n\s+type: string/);
    assert.match(yaml, /confirmacao:\n\s+description: "Digite HOMOLOGACAO-BACKEND[^\n]*\n\s+required: true\n\s+type: string/);
    assert.match(yaml, /publicar:\n\s+description:[^\n]*\n\s+required: false\n\s+type: boolean\n\s+default: false/);
    assert.doesNotMatch(yaml, /permitir_commit_anterior|permitir_anterior/);
  });
  test('permissões mínimas no topo (só contents: read) e concorrência serializada com a do frontend, sem cancelar a em andamento', () => {
    assert.match(yaml, /\npermissions:\n  contents: read\n(?!  )/);
    assert.match(yaml, /concurrency:\n  group: deploy-hml\n  cancel-in-progress: false/);
  });
  test('S8264: nada de actions: read no nível global; cada job declara o que usa', () => {
    const topo = yaml.slice(0, yaml.indexOf('\njobs:\n'));
    assert.doesNotMatch(topo, /^\s*actions:/m, 'actions: read não pode estar no nível do workflow');
    assert.match(job('validar'), /\n    permissions:\n      contents: read\n      actions: read\n/);
    assert.doesNotMatch(job('empacotar'), /^\s{4}permissions:/m);
    assert.match(job('publicar'), /\n    permissions:\n      contents: read\n      actions: read\n      id-token: write\n/);
  });
  test('o job que consulta a API de execuções do CI é o que recebe actions: read', () => {
    assert.match(job('validar'), /gh api "repos\/\$\{GITHUB_REPOSITORY\}\/actions\/workflows\/ci\.yml\/runs/);
    assert.doesNotMatch(job('empacotar'), /gh api/);
  });
  test('nenhuma permissão de escrita no arquivo além de id-token: write (uma única vez, no job publicar)', () => {
    const escritas = [...yaml.matchAll(/^\s+([a-z-]+): write\s*$/gm)].map((m) => m[1]);
    assert.deepEqual(escritas, ['id-token']);
  });
});

describe('deploy-hml-backend.yml: confirmação, validação e empacotamento', () => {
  test('confirmação literal específica do backend; a do frontend não vale', () => {
    assert.match(yaml, /\[ "\$CONFIRMACAO" = "HOMOLOGACAO-BACKEND" \]/);
    assert.doesNotMatch(yaml, /= "HOMOLOGACAO" \]/);
  });
  test('execução só a partir da main e SHA completo de 40 hex', () => {
    const v = job('validar');
    assert.match(v, /refs\/heads\/main/);
    assert.match(v, /\^\[0-9a-f\]\{40\}\$/);
  });
  test('reaproveita as validações do CD: fatos, CI verde, cabeça da main e decisão fail-closed', () => {
    const v = job('validar');
    assert.match(v, /node --test "\.github\/scripts\/hml\/test\/\*\.test\.js"/);
    assert.match(v, /node \.github\/scripts\/hml\/validar-commit\.js --fatos/);
    assert.match(v, /git merge-base --is-ancestor/);
    assert.match(v, /actions\/workflows\/ci\.yml\/runs\?head_sha=/);
  });
  test('o backend nunca é retroativo: exige atual=true', () => {
    assert.match(job('validar'), /\[ "\$ATUAL" = "true" \] \|\| \{[^}]*retroativ/i);
  });
  test('empacota com o empacotador oficial do backend, confere e fixa o hash do release.json antes da aprovação', () => {
    const e = job('empacotar');
    assert.match(e, /node deploy\/hml\/empacotar-backend\.js --saida "\$RUNNER_TEMP\/release" --commit "\$COMMIT" --rotulo "\$ROTULO" --atual "\$ATUAL"/);
    assert.match(e, /ref: \$\{\{ needs\.validar\.outputs\.commit \}\}/);
    assert.match(e, /git status --porcelain/);
    assert.match(e, /\(cd "\$RUNNER_TEMP\/release\/backend" && sha256sum -c --quiet \.\.\/manifesto-backend\.sha256\)|cd "\$RUNNER_TEMP\/release\/backend" && sha256sum -c --quiet \.\.\/manifesto-backend\.sha256/);
    assert.match(e, /sha256sum "\$RUNNER_TEMP\/release\/release\.json"/);
    assert.match(e, /release_sha256: \$\{\{ steps\.selo\.outputs\.release_sha256 \}\}/);
    assert.match(e, /name: release-backend-\$\{\{ needs\.validar\.outputs\.rotulo \}\}/);
    assert.doesNotMatch(e, /id-token|aws-actions|environment:/);
  });
  test('o job de empacotar não recebe credenciais nem environment', () => {
    for (const nome of ['validar', 'empacotar']) assert.doesNotMatch(job(nome), /id-token|aws-actions|environment:/);
  });
});

describe('deploy-hml-backend.yml: publicação atrás do environment e dos interruptores próprios', () => {
  const p = () => job('publicar');
  test('o job publicar existe e depende de validar e empacotar', () => {
    assert.ok(p().length > 0);
    assert.match(p(), /needs: \[validar, empacotar\]/);
  });
  test('environment próprio e único; o do frontend não aparece', () => {
    assert.equal((yaml.match(/^\s+environment:/gm) || []).length, 1);
    assert.match(p(), /environment: homologacao-backend\n/);
    assert.doesNotMatch(yaml, /environment: homologacao\s*$/m);
  });
  test('só publicar recebe OIDC, e só depois de conferir destino e release', () => {
    assert.equal((yaml.match(/id-token: write/g) || []).length, 1);
    assert.equal((yaml.match(/uses: aws-actions\//g) || []).length, 1);
    const antes = yaml.slice(0, yaml.indexOf('\n  publicar:\n'));
    assert.doesNotMatch(antes, /id-token|aws-actions/);
    const j = p();
    assert.ok(j.indexOf('p.validarDestino') >= 0 && j.indexOf('p.validarDestino') < j.indexOf('uses: aws-actions/'));
    assert.ok(j.indexOf('p.conferirRelease') >= 0 && j.indexOf('p.conferirRelease') < j.indexOf('uses: aws-actions/'));
    assert.ok(j.indexOf('validar-automatico.js --atualidade') >= 0 && j.indexOf('validar-automatico.js --atualidade') < j.indexOf('uses: aws-actions/'));
  });
  test('a conferência da release declara o escopo backend e usa o hash fixado antes da aprovação', () => {
    const j = p();
    assert.match(j, /p\.conferirRelease\(\{[^}]*escopo: ?["']backend["'][^}]*\}\)/);
    assert.match(j, /HML_RELEASE_SHA256: \$\{\{ needs\.empacotar\.outputs\.release_sha256 \}\}/);
    assert.match(j, /HML_COMMIT: \$\{\{ needs\.validar\.outputs\.commit \}\}/);
    assert.match(j, /artifact-ids: \$\{\{ needs\.empacotar\.outputs\.artifact_id \}\}/);
    assert.match(j, /ref: \$\{\{ github\.workflow_sha \}\}/);
    assert.doesNotMatch(j, /run-id:|ref: main/);
  });
  test('interruptor próprio, disparo manual, publicar=true, main e repositório', () => {
    const j = p();
    for (const r of ["vars.HML_BACKEND_PUBLICACAO_HABILITADA == 'true'", "github.repository == 'ramirespaes/Gestao_Epi_Fabricas'", "github.ref == 'refs/heads/main'", "github.event_name == 'workflow_dispatch'", 'inputs.publicar == true']) {
      assert.ok(j.includes(r), `falta a condição: ${r}`);
    }
    assert.doesNotMatch(yaml, /HML_PUBLICACAO_HABILITADA/, 'o interruptor do frontend não pode habilitar o backend');
  });
  test('role AWS própria do backend; a role do frontend nunca aparece', () => {
    assert.match(p(), /role-to-assume: \$\{\{ vars\.HML_BACKEND_AWS_ROLE_ARN \}\}/);
    assert.match(p(), /HML_ROLE: \$\{\{ vars\.HML_BACKEND_AWS_ROLE_ARN \}\}/);
    assert.doesNotMatch(yaml, /vars\.HML_AWS_ROLE_ARN/);
  });
  test('o pedido é entregue com escopo backend, confirmação própria e sem commit anterior', () => {
    const j = p();
    assert.match(j, /HML_ESCOPO: backend/);
    assert.match(j, /HML_BACKEND_HABILITADA: \$\{\{ vars\.HML_BACKEND_PUBLICACAO_HABILITADA \}\}/);
    assert.match(j, /HML_CONFIRMACAO: \$\{\{ inputs\.confirmacao \}\}/);
    assert.match(j, /HML_PUBLICAR: \$\{\{ inputs\.publicar \}\}/);
    assert.match(j, /HML_PERMITIR_ANTERIOR: "false"/);
    assert.match(j, /run: node deploy\/hml\/cd\/publicar\.js/);
  });
  test('credenciais temporárias por OIDC, com as mesmas salvaguardas do frontend', () => {
    const j = p();
    assert.match(j, /audience: sts\.amazonaws\.com/);
    assert.match(j, /unset-current-credentials: true/);
    assert.match(j, /mask-aws-account-id: true/);
    assert.match(j, /role-duration-seconds: 1800/);
  });
});

describe('deploy-hml-backend.yml: higiene e isolamento do fluxo do frontend', () => {
  test('sem secrets, sem continue-on-error, sem always(), sem runner próprio, sem credenciais literais', () => {
    assert.doesNotMatch(yaml, /\bsecrets\.|continue-on-error|if:.*always\(|self-hosted|AKIA[0-9A-Z]{16}|aws_secret_access_key/i);
  });
  test('todas as ações são fixadas por SHA, os mesmos SHAs já usados pelo workflow do frontend', () => {
    const usos = [...yaml.matchAll(/uses: ([^\s@]+)@([0-9a-f]{40})/g)];
    const todos = [...yaml.matchAll(/uses: ([^\s]+)/g)];
    assert.ok(todos.length > 0 && usos.length === todos.length, 'toda ação precisa estar fixada por SHA de 40 hex');
    for (const [, acao, sha] of usos) assert.ok(FRONT.includes(`${acao}@${sha}`), `${acao}@${sha} não é usada no workflow do frontend`);
  });
  test('o workflow do frontend não conhece o escopo, o environment, o interruptor nem a role do backend', () => {
    assert.doesNotMatch(FRONT, /homologacao-backend|HML_BACKEND|HML_ESCOPO|HOMOLOGACAO-BACKEND|hml-backend/);
  });
  test('o job publicar do frontend continua no environment homologacao', () => {
    assert.match(FRONT, /environment: homologacao\n/);
  });
  test('o workflow do backend não toca o agente nem o instalador: só entrega o pedido (publicar.js)', () => {
    assert.doesNotMatch(yaml, /agente-invocar|agente\.js|deploy\/hml\/instalador|instalar-release|systemctl|\bssh |\bscp /i);
  });
});
