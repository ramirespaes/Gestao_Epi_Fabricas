'use strict';
// 3B-4: o deploy-hml.yml passa a preparar e conferir o backend do MESMO commit, num job à parte, sem credenciais, sem
// environment e sem entregar pedido. Tudo o que já existia (gatilhos, validação, pacotes e publicação do Portal e do
// Painel) fica byte a byte como estava: o texto anterior ao job novo tem o hash do arquivo original.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '../../../..');
const yaml = fs.readFileSync(path.join(RAIZ, '.github/workflows/deploy-hml.yml'), 'utf8');
// Hash do deploy-hml.yml da main em d0a3011, antes desta etapa (o mesmo que frontend-inalterado.test.js fixava).
const HASH_ORIGINAL = '1e4a6bf81ff7b50d107a25a23a27d0ccc8ae4ab8b276b0c6dc97f20c2c533320';
// O nome do job não tem hífen de propósito: os testes existentes reconhecem a fronteira entre jobs por \w+.
const MARCA = '\n  conjunto:\n';
const sha = (t) => crypto.createHash('sha256').update(t).digest('hex');
const semComentarios = (t) => t.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
const partes = yaml.split(MARCA);
const job = partes.length === 2 ? semComentarios(partes[1]) : '';
const passos = [...job.matchAll(/^ {6}- name: ([^\n]+)/gm)].map((m) => m[1]);
const blocoDoPasso = (inicio) => { const i = job.indexOf(`- name: ${inicio}`); return i === -1 ? '' : job.slice(i).split(/\n {6}- name: /)[0]; };
// Guarda de origem do job validar (a expressão inteira dentro de ${{ }}), e o if do job conjunto.
const GUARDA_DO_VALIDAR = yaml.match(/^ {2}validar:\n[\s\S]*?^ {4}if: \$\{\{ (.+) \}\}$/m)[1];
const ifDoConjunto = (job.match(/^ {4}if: (.+)$/m) || [])[1];

describe('preservação do frontend e dos controles existentes', () => {
  test('o job novo existe, uma única vez, e é o último do arquivo', () => {
    assert.equal(partes.length, 2, 'falta o job conjunto (RED esperado antes da implementação)');
    assert.doesNotMatch(job, /^ {2}[\w-]+:\s*$/m, 'nenhum job depois dele');
    assert.match(MARCA, /^\n {2}\w+:\n$/);
  });

  test('tudo o que vem antes do job novo é o arquivo original, byte a byte (gatilhos, validar, empacotar e publicar)', () => {
    const anterior = yaml.slice(0, yaml.indexOf(MARCA) + 1);
    const semComentarioFinal = anterior.replace(/(\n {2}#[^\n]*)+\n$/, '\n').replace(/\n\n$/, '\n');
    assert.equal(sha(semComentarioFinal), HASH_ORIGINAL);
  });

  test('os jobs são exatamente os três de antes mais o novo, nesta ordem', () => {
    const jobs = yaml.match(/^jobs:\n([\s\S]*)$/m)[1];
    assert.deepEqual([...jobs.matchAll(/^ {2}([\w-]+):\s*$/gm)].map((m) => m[1]), ['validar', 'empacotar', 'publicar', 'conjunto']);
  });

  test('o job publicar não depende do job novo: falha na preparação do backend não impede a publicação do frontend', () => {
    const publicar = semComentarios(yaml.split('\n  publicar:\n')[1].split(MARCA)[0]);
    assert.match(publicar, /^ {4}needs: \[validar, empacotar\]$/m);
    assert.doesNotMatch(publicar, /conjunto|backend/i);
    assert.deepEqual([...semComentarios(yaml).matchAll(/^ {4}needs: (.+)$/gm)].map((m) => m[1]), ['validar', '[validar, empacotar]', '[validar, empacotar]'], 'ninguém depende do job novo');
  });

  test('continua havendo um único environment, um único id-token e nenhuma outra permissão de escrita', () => {
    assert.equal((yaml.match(/^\s*environment:/gm) || []).length, 1);
    assert.equal((yaml.match(/id-token: write/g) || []).length, 1);
    assert.deepEqual(semComentarios(yaml).match(/^\s*[\w-]+:\s*write\b/gm).map((l) => l.trim()), ['id-token: write']);
    assert.equal((semComentarios(yaml).match(/^\s*permissions:/gm) || []).length, 2, 'só o topo e o job publicar declaram permissões');
  });
});

describe('job conjunto: mesmo commit, sem credenciais e sem publicar', () => {
  test('depende da validação do commit (CI verde, posição na main) e do pacote do frontend desta execução', () => {
    assert.match(job, /^ {4}needs: \[validar, empacotar\]$/m);
  });

  test('S7631: o if do job é a condição de "atual" combinada com a guarda de origem do validar, copiada literalmente', () => {
    assert.equal(ifDoConjunto, `\${{ needs.validar.outputs.atual == 'true' && (${GUARDA_DO_VALIDAR}) }}`);
    assert.match(GUARDA_DO_VALIDAR, /github\.event\.workflow_run\.head_repository\.full_name == github\.repository/);
    assert.deepEqual(job.match(/^\s*if:.*$/gm).map((l) => l.trim()), [`if: ${ifDoConjunto}`, 'if: failure()'], 'só a condição do job e a do passo que registra a falha');
  });

  test('o cabeçalho do job só tem expressão ${{ }} na linha if e não tem saídas: nada depende dele', () => {
    const cabecalho = job.split(/\n {4}steps:\n/)[0];
    assert.deepEqual(cabecalho.split('\n').filter((l) => l.includes('${{')).map((l) => l.trim().split(':')[0]), ['if']);
    assert.doesNotMatch(job, /^ {4}outputs:/m);
    assert.doesNotMatch(yaml, /needs\.conjunto\b/);
  });
});

describe('S7631: em que situações o job conjunto roda (condições avaliadas, não só lidas)', () => {
  // Avaliador mínimo do subconjunto de expressões usado nesses if (==, !=, &&, ||, parênteses, textos e caminhos), com a
  // comparação de textos sem distinção de maiúsculas, como no GitHub. Qualquer outra coisa é erro, não falso.
  function avaliar(expressao, ctx) {
    const fonte = expressao.trim().replace(/^\$\{\{([\s\S]*)\}\}$/, '$1');
    const tokens = fonte.match(/\s*(?:'(?:[^']|'')*'|&&|\|\||==|!=|[()]|[A-Za-z_][\w.-]*)/g);
    assert.equal((tokens || []).join('').replace(/\s/g, ''), fonte.replace(/\s/g, ''), `expressão fora do subconjunto: ${fonte}`);
    let i = 0;
    const proximo = () => tokens[i] && tokens[i].trim();
    const valor = (t) => {
      if (t.startsWith("'")) return t.slice(1, -1).replace(/''/g, "'");
      if (t === 'true' || t === 'false') return t === 'true';
      return t.split('.').reduce((o, k) => (o == null ? undefined : o[k]), ctx);
    };
    const igual = (a, b) => (typeof a === 'string' && typeof b === 'string' ? a.toLowerCase() === b.toLowerCase() : a === b);
    function primario() {
      const t = proximo(); i += 1;
      if (t === '(') { const v = ou(); assert.equal(proximo(), ')'); i += 1; return v; }
      return valor(t);
    }
    function comparacao() {
      let a = primario();
      while (proximo() === '==' || proximo() === '!=') { const op = proximo(); i += 1; const b = primario(); a = op === '==' ? igual(a, b) : !igual(a, b); }
      return a;
    }
    function e() { let a = comparacao(); while (proximo() === '&&') { i += 1; const b = comparacao(); a = Boolean(a) && Boolean(b); } return a; }
    function ou() { let a = e(); while (proximo() === '||') { i += 1; const b = e(); a = Boolean(a) || Boolean(b); } return a; }
    const resultado = ou();
    assert.equal(i, tokens.length, 'sobrou texto na expressão');
    return Boolean(resultado);
  }
  const ifDoValidar = yaml.match(/^ {2}validar:\n[\s\S]*?^ {4}if: (.+)$/m)[1];
  // O job roda se o validar rodou e teve sucesso (success() implícito) e se o if dele próprio for verdadeiro.
  const rodaConjunto = (ctx, { validarComSucesso = true } = {}) => avaliar(ifDoValidar, ctx) && validarComSucesso && avaliar(ifDoConjunto, ctx);
  const REPO = 'ramirespaes/Gestao_Epi_Fabricas';
  const execucao = (sobre = {}) => ({ event: 'push', conclusion: 'success', head_branch: 'main', head_repository: { full_name: REPO }, ...sobre });
  const contexto = ({ evento = 'workflow_run', run = execucao(), atual = 'true' } = {}) => ({
    github: { event_name: evento, repository: REPO, event: evento === 'workflow_run' ? { workflow_run: run } : {} },
    needs: { validar: { outputs: { atual } } },
  });

  test('push legítimo na main do próprio repositório, com CI verde: roda', () => {
    assert.equal(avaliar(ifDoConjunto, contexto()), true);
    assert.equal(rodaConjunto(contexto()), true);
  });

  test('disparo manual (a confirmação e o commit seguem validados pelo job validar): roda', () => {
    assert.equal(rodaConjunto(contexto({ evento: 'workflow_dispatch' })), true);
  });

  test('origem de fork: não roda, pela guarda do próprio job, mesmo que o validar tivesse rodado', () => {
    const fork = contexto({ run: execucao({ head_repository: { full_name: 'atacante/Gestao_Epi_Fabricas' } }) });
    assert.equal(avaliar(ifDoConjunto, fork), false, 'a guarda do conjunto, sozinha, já recusa');
    assert.equal(rodaConjunto(fork, { validarComSucesso: true }), false);
  });

  test('CI reprovado, cancelado, de PR ou de outra branch: não roda', () => {
    for (const sobre of [{ conclusion: 'failure' }, { conclusion: 'cancelled' }, { event: 'pull_request' }, { head_branch: 'outra' }]) {
      assert.equal(avaliar(ifDoConjunto, contexto({ run: execucao(sobre) })), false, JSON.stringify(sobre));
    }
  });

  test('release retroativa (atual = false) ou validação sem resultado: não roda, em nenhum evento', () => {
    for (const evento of ['workflow_run', 'workflow_dispatch']) {
      assert.equal(rodaConjunto(contexto({ evento, atual: 'false' })), false, evento);
      assert.equal(rodaConjunto(contexto({ evento, atual: '' })), false, `${evento}: saída ausente chega como texto vazio`);
    }
    assert.equal(rodaConjunto(contexto(), { validarComSucesso: false }), false, 'validar falho ou pulado');
  });

  test('evento não previsto: não roda', () => {
    for (const evento of ['pull_request_target', 'push', 'schedule', 'issue_comment']) assert.equal(avaliar(ifDoConjunto, contexto({ evento })), false, evento);
  });

  test('o avaliador do teste recusa expressão fora do subconjunto, em vez de responder falso', () => {
    assert.throws(() => avaliar("${{ contains(github.ref, 'main') }}", contexto()));
  });
});

describe('job conjunto: checkout e conferência antes de qualquer script', () => {

  test('S7631: o checkout é da main do próprio repositório, nunca de um ref vindo do evento ou das saídas de outro job', () => {
    const checkout = blocoDoPasso(passos[0]);
    assert.equal(passos[0], 'Checkout da main (precisa ser exatamente o commit validado)');
    assert.match(checkout, /uses: actions\/checkout@11bd71901bbe5b1630ceea73d27597364c9af683[^\n]*\n\s+with:\n\s+ref: main\n\s+persist-credentials: false\n?$/);
    assert.doesNotMatch(checkout, /\$\{\{|repository:|token:|fetch-depth/, 'nenhuma expressão, outro repositório, credencial ou histórico');
    assert.equal((job.match(/uses: actions\/checkout@/g) || []).length, 1, 'um único checkout no job');
    assert.doesNotMatch(job, /github\.workflow_sha|github\.event\.workflow_run\.head_sha|ref: \$\{\{/);
  });

  test('a conferência HEAD == commit validado e árvore limpa vem logo depois do checkout, antes de qualquer código do repositório', () => {
    assert.equal(passos[1], 'Conferir que o checkout é exatamente o commit validado');
    const confere = blocoDoPasso(passos[1]);
    assert.match(confere, /COMMIT: \$\{\{ needs\.validar\.outputs\.commit \}\}/);
    assert.match(confere, /\[ "\$\(git rev-parse HEAD\)" = "\$COMMIT" \] \|\| \{[^}]*exit 1; \}/);
    assert.match(confere, /\[ -z "\$\(git status --porcelain\)" \] \|\| \{[^}]*exit 1; \}/);
    assert.ok(job.indexOf('git rev-parse HEAD') < job.indexOf('node '), 'a conferência vem antes de qualquer script');
    // Depois dela só vêm passos sem condição: se ela falhar, nenhum deles roda; só o registro de falha, que não executa código.
    const seguintes = passos.slice(2, -1).map(blocoDoPasso);
    assert.ok(seguintes.length >= 5);
    for (const bloco of seguintes) assert.doesNotMatch(bloco, /^\s*if:|continue-on-error/m);
    assert.doesNotMatch(blocoDoPasso(passos.at(-1)), /\bnode\b|uses:|\.\/|deploy\/|\.github\/scripts/);
  });
});

describe('S7631: a conferência do checkout, executada de verdade num repositório git temporário', () => {
  const { spawnSync } = require('node:child_process');
  const os = require('node:os');
  // O corpo do passo exatamente como está no workflow, recortado pela indentação do bloco "run: |".
  const corpo = (() => {
    const bloco = blocoDoPasso('Conferir que o checkout é exatamente o commit validado');
    const i = bloco.indexOf('run: |\n');
    return i === -1 ? '' : bloco.slice(i + 'run: |\n'.length).split('\n').filter((l) => l.startsWith('          ')).map((l) => l.slice(10)).join('\n');
  })();
  const git = (dir, ...args) => {
    const r = spawnSync('git', ['-c', 'user.name=teste', '-c', 'user.email=teste@exemplo.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, GIT_CONFIG_NOSYSTEM: '1' } });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  function repositorio() {
    const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'conferencia-checkout-'));
    git(dir, 'init', '-q', '-b', 'main');
    fs.writeFileSync(path.join(dir, 'a.txt'), '1');
    git(dir, 'add', 'a.txt'); git(dir, 'commit', '-q', '-m', 'primeiro');
    const validado = git(dir, 'rev-parse', 'HEAD');
    return { dir, validado };
  }
  const conferir = (dir, commit) => spawnSync('bash', ['-eo', 'pipefail', '-c', corpo], { cwd: dir, encoding: 'utf8', env: { PATH: process.env.PATH, HOME: dir, COMMIT: commit }, timeout: 20000 });

  test('o corpo do passo foi encontrado e contém as duas conferências', () => {
    assert.match(corpo, /git rev-parse HEAD/);
    assert.match(corpo, /git status --porcelain/);
  });

  test('main igual ao commit validado e árvore limpa: segue (código 0)', () => {
    const { dir, validado } = repositorio();
    try { assert.equal(conferir(dir, validado).status, 0); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('main avançou depois da validação (HEAD diferente do commit aprovado): interrompe antes de qualquer script', () => {
    const { dir, validado } = repositorio();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), '2');
      git(dir, 'commit', '-q', '-am', 'main avançou');
      const r = conferir(dir, validado);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /checkout diferente do commit validado/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('commit aprovado vazio, abreviado ou de outro histórico: interrompe', () => {
    const { dir, validado } = repositorio();
    try {
      for (const commit of ['', validado.slice(0, 7), 'f'.repeat(40)]) assert.equal(conferir(dir, commit).status, 1, JSON.stringify(commit));
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });

  test('HEAD certo com árvore suja ou arquivo não rastreado: interrompe', () => {
    const { dir, validado } = repositorio();
    try {
      fs.writeFileSync(path.join(dir, 'a.txt'), 'alterado');
      assert.equal(conferir(dir, validado).status, 1);
      git(dir, 'checkout', '-q', '--', 'a.txt');
      fs.writeFileSync(path.join(dir, 'intruso.js'), 'x');
      const r = conferir(dir, validado);
      assert.equal(r.status, 1);
      assert.match(r.stdout, /árvore de trabalho não está limpa/);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
});

describe('job conjunto: demais contratos', () => {

  test('gera a release do backend com o empacotador oficial, com commit, rótulo e marca "atual" da validação', () => {
    const gerar = blocoDoPasso('Gerar release do backend');
    assert.match(gerar, /COMMIT: \$\{\{ needs\.validar\.outputs\.commit \}\}/);
    assert.match(gerar, /ROTULO: \$\{\{ needs\.validar\.outputs\.rotulo \}\}/);
    assert.match(gerar, /ATUAL: \$\{\{ needs\.validar\.outputs\.atual \}\}/);
    assert.match(gerar, /run: node deploy\/hml\/empacotar-backend\.js --saida "\$RUNNER_TEMP\/release-backend" --commit "\$COMMIT" --rotulo "\$ROTULO" --atual "\$ATUAL"\n/);
    assert.match(job, /cd "\$RUNNER_TEMP\/release-backend\/backend" && sha256sum -c --quiet \.\.\/manifesto-backend\.sha256/);
  });

  test('baixa somente o artefato do frontend desta execução, pelo identificador', () => {
    const baixar = blocoDoPasso('Baixar somente o artefato do frontend');
    assert.match(baixar, /uses: actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
    assert.match(baixar, /artifact-ids: \$\{\{ needs\.empacotar\.outputs\.artifact_id \}\}/);
    assert.doesNotMatch(baixar, /run-id:|repository:|github-token|name:\s*release/);
  });

  test('confere o conjunto com o script testado, contra o commit, o rótulo e o hash do frontend fixado antes da aprovação', () => {
    const conferir = blocoDoPasso('Conferir o conjunto');
    assert.match(conferir, /HML_COMMIT: \$\{\{ needs\.validar\.outputs\.commit \}\}/);
    assert.match(conferir, /HML_ROTULO: \$\{\{ needs\.validar\.outputs\.rotulo \}\}/);
    assert.match(conferir, /HML_RELEASE_SHA256: \$\{\{ needs\.empacotar\.outputs\.release_sha256 \}\}/);
    assert.match(conferir, /run: node \.github\/scripts\/hml\/conferir-conjunto\.js\n/);
    assert.ok(job.indexOf('empacotar-backend.js') < job.indexOf('conferir-conjunto.js'));
    assert.ok(job.indexOf('download-artifact') < job.indexOf('conferir-conjunto.js'));
  });

  test('guarda a release do backend e o conjunto só como artefato de retenção curta, depois de conferidos', () => {
    const guardar = blocoDoPasso('Guardar release do backend');
    assert.match(guardar, /uses: actions\/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02/);
    assert.match(guardar, /if-no-files-found: error/);
    assert.match(guardar, /retention-days: 14/);
    assert.ok(job.indexOf('conferir-conjunto.js') < job.indexOf('upload-artifact'));
    assert.equal(passos.at(-2).startsWith('Guardar release do backend'), true, 'depois dele só o registro de falha');
    assert.doesNotMatch(guardar, /^\s*if:/m, 'só guarda quando tudo antes deu certo');
  });

  test('não recebe environment, OIDC, permissões próprias, variáveis de repositório, segredos nem credenciais', () => {
    for (const proibido of [/^\s*environment:/m, /^\s*permissions:/m, /id-token/, /\bvars\./, /\bsecrets\./, /github\.token|GH_TOKEN/, /aws-actions|configure-aws|AWS_/i, /HML_ROLE|HML_BUCKET|HML_CONTA|HML_REGIAO/]) {
      assert.doesNotMatch(job, proibido, String(proibido));
    }
  });

  test('não entrega pedido, não aciona agente nem instalador, não toca banco nem servidor', () => {
    for (const proibido of [/publicar\.js/, /HML_PUBLICAR|HML_HABILITADA|HML_CONFIRMACAO/, /agente/i, /instalador|instalar-release/, /coordenacao/i, /migrate|psql|db:/i, /\bssh\b|\bscp\b|\bcurl\b|\bwget\b|systemctl|\bsudo\b|\baws\b/, /git (push|commit|tag)/]) {
      assert.doesNotMatch(job, proibido, String(proibido));
    }
  });

  test('não conhece o environment, o interruptor, a role, o escopo de pedido nem o prefixo S3 do backend', () => {
    assert.doesNotMatch(yaml, /homologacao-backend|HML_BACKEND|HML_ESCOPO|HOMOLOGACAO-BACKEND|hml-backend/);
  });

  test('sem always(), sem cancelled(), sem runner próprio; failure() só no passo que registra a falha', () => {
    assert.doesNotMatch(job, /always\(|cancelled\(|self-hosted/);
    assert.equal((job.match(/failure\(/g) || []).length, 1);
    assert.match(job, /^ {4}runs-on: ubuntu-latest$/m);
    assert.match(job, /^ {4}timeout-minutes: 15$/m);
  });
});

describe('correção P1: a preparação do backend não reprova uma publicação bem-sucedida do frontend', () => {
  const publicar = semComentarios(yaml.split('\n  publicar:\n')[1].split(MARCA)[0]);
  const antesDoConjunto = semComentarios(yaml.split(MARCA)[0]);
  const cabecalho = job.split(/\n {4}steps:\n/)[0];

  test('o job conjunto é não bloqueante: continue-on-error: true no nível do job, uma única vez em todo o arquivo', () => {
    assert.match(cabecalho, /^ {4}continue-on-error: true$/m);
    assert.deepEqual(semComentarios(yaml).match(/^.*continue-on-error.*$/gm), ['    continue-on-error: true']);
  });

  test('nenhum passo usa continue-on-error: a falha continua aparecendo no passo e no job', () => {
    assert.doesNotMatch(job.split(/\n {4}steps:\n/)[1], /continue-on-error/);
  });

  test('validar, empacotar e publicar não ganham continue-on-error: testes obrigatórios, validação e publicação seguem bloqueantes', () => {
    assert.doesNotMatch(antesDoConjunto, /continue-on-error/);
    assert.match(antesDoConjunto, /run: node --test "\.github\/scripts\/hml\/test\/\*\.test\.js"/);
    assert.doesNotMatch(publicar, /continue-on-error|failure\(|always\(|cancelled\(/);
  });

  test('uma falha no próprio publicar continua reprovando a execução: o job segue igual, sem depender do conjunto', () => {
    assert.match(publicar, /^ {4}needs: \[validar, empacotar\]$/m);
    assert.match(publicar, /^ {4}environment: homologacao$/m);
    assert.match(publicar, /run: node deploy\/hml\/cd\/publicar\.js\n?$/);
    assert.doesNotMatch(publicar, /conjunto|backend/i);
  });

  test('publicação desabilitada e rollback retroativo: as condições do publicar e do conjunto não mudaram', () => {
    assert.match(publicar, /^ {4}if: \$\{\{ vars\.HML_PUBLICACAO_HABILITADA == 'true' && /m);
    assert.match(cabecalho, /^ {4}if: \$\{\{ needs\.validar\.outputs\.atual == 'true' && \(/m);
    assert.match(cabecalho, /^ {4}needs: \[validar, empacotar\]$/m);
  });

  test('a falha fica registrada: último passo, só em falha, escreve PREPARACAO_CONJUNTO_FALHOU no log e no resumo', () => {
    assert.equal(passos.at(-1).startsWith('Registrar a falha da preparação do conjunto'), true);
    const registro = blocoDoPasso(passos.at(-1));
    assert.match(registro, /^ {8}if: failure\(\)$/m);
    assert.match(registro, /echo "::error[^"]*PREPARACAO_CONJUNTO_FALHOU/);
    assert.match(registro, />> "\$GITHUB_STEP_SUMMARY"/);
    assert.ok((registro.match(/PREPARACAO_CONJUNTO_FALHOU/g) || []).length >= 2, 'no log e no resumo');
    assert.doesNotMatch(registro, /uses:|\bnode\b|\$\{\{/, 'só mensagens: nenhum script, ação ou valor de contexto');
  });

  test('ajuste P2: falha no armazenamento do artefato também é registrada como PREPARACAO_CONJUNTO_FALHOU, sem ser mascarada', () => {
    const guardar = blocoDoPasso('Guardar release do backend');
    const registro = blocoDoPasso(passos.at(-1));
    assert.ok(job.indexOf('upload-artifact') < job.indexOf('if: failure()'), 'o registro vem depois do armazenamento');
    assert.doesNotMatch(guardar, /continue-on-error|^\s*if:/m, 'o armazenamento falha de verdade quando falha');
    assert.match(registro, /geração, a conferência ou o armazenamento do artefato/);
    // Se a conferência terminou e só o armazenamento falhou, o resumo terá os dois status: o registro diz qual prevalece.
    assert.match(registro, /PREPARACAO_CONJUNTO_CONFERIDA[^\n]*(não vale|prevalece)/);
    assert.doesNotMatch(registro, /conferência (do backend )?NÃO foi conclu/, 'não nega uma conferência que pode ter terminado');
  });

  test('ajuste P2: o comentário do job não diz mais que a falha dele reprova a execução', () => {
    const comentario = yaml.split(MARCA)[0].split('\n').reverse().filter((l, i, todas) => todas.slice(0, i + 1).every((x) => /^ {2}#/.test(x))).reverse().join('\n');
    assert.ok(comentario.length > 0);
    assert.doesNotMatch(comentario, /reprova a execução, mas/);
    assert.match(comentario, /não reprova/);
  });

  test('o registro de falha não afirma sucesso da conferência nem publicação do backend, e diz o que a falha não afeta', () => {
    const registro = blocoDoPasso(passos.at(-1));
    assert.match(registro, /preparação do conjunto NÃO foi conclu[ií]da/);
    assert.match(registro, /NÃO (foi )?publicado/);
    assert.match(registro, /Portal e Painel/);
    assert.doesNotMatch(registro, /conferid[oa] com sucesso|conjunto (íntegro|aprovado)|\bOK\b/i);
  });
});

describe('job conjunto: demais invariantes', () => {

  test('só ações já usadas no arquivo, fixadas pelos mesmos SHAs; valores do contexto nunca são interpolados em run', () => {
    const original = yaml.split(MARCA)[0];
    const usos = [...job.matchAll(/uses: (\S+)/g)].map((m) => m[1]);
    assert.ok(usos.length >= 4);
    for (const uso of usos) { assert.match(uso, /@[0-9a-f]{40}$/); assert.ok(original.includes(`uses: ${uso}`), `${uso} não era usada antes`); }
    for (const bloco of job.split(/\n\s+run:/).slice(1)) assert.doesNotMatch(bloco.split(/\n\s+- name:/)[0], /\$\{\{/);
  });

  test('o nome do job e os comentários dizem que o backend é preparado, não publicado', () => {
    assert.match(job, /^ {4}name: [^\n]*backend[^\n]*\(sem publicar\)$/m);
    assert.doesNotMatch(yaml, /três componentes publicados|publica(r|ção) d?os três|backend publicado/i);
  });
});

describe('controles de autorização e segurança não mudaram', () => {
  test('CI inválido e commit fora da main continuam decididos pelos mesmos scripts, antes de qualquer pacote', () => {
    const validar = yaml.match(/^ {2}validar:\n([\s\S]*?)^ {2}empacotar:/m)[1];
    assert.match(validar, /node \.github\/scripts\/hml\/validar-automatico\.js --fatos/);
    assert.match(validar, /node \.github\/scripts\/hml\/validar-commit\.js --fatos/);
  });

  test('a alteração da main durante a aprovação continua barrando a publicação, antes de qualquer credencial', () => {
    const publicar = yaml.split('\n  publicar:\n')[1].split(MARCA)[0];
    assert.ok(publicar.indexOf('validar-automatico.js --atualidade') > 0);
    assert.ok(publicar.indexOf('validar-automatico.js --atualidade') < publicar.indexOf('uses: aws-actions/'));
  });

  test('os scripts de validação, o protocolo, o publicador e o workflow do backend seguem com os hashes da main', () => {
    const esperado = {
      'deploy/hml/cd/protocolo.js': '759676fa891812e40d7e3720d0dc12b8b0bd7d9204c6c1ea8a70d067e7eb9b58',
      'deploy/hml/cd/publicar.js': '6b0f84c70827fa75c3caecb4ad70623a06ed149c66f2d19d3ce2fa53c4eec92a',
      'deploy/hml/instalador/coordenacao.js': 'efea0982ed7a156433c0704bc4a73199e12baa5643a59fec7615a2ad6ae34995',
      '.github/workflows/deploy-hml-backend.yml': 'f1f3afb14770541fa86dfb7f1797fdf15ab30ee257f87a8afabade93ed52b0e1',
    };
    for (const [rel, hash] of Object.entries(esperado)) assert.equal(sha(fs.readFileSync(path.join(RAIZ, rel))), hash, rel);
  });

  test('o backend continua bloqueado: nenhum provedor homologado e a política ainda responde COORDENACAO_NAO_HOMOLOGADA', () => {
    const C = require(path.join(RAIZ, 'deploy/hml/instalador/coordenacao'));
    assert.equal(C.provedorHomologado(async () => ({ situacao: 'LIVRE', origem: 'x', consultadoEm: new Date().toISOString() })), false);
    assert.match(fs.readFileSync(path.join(RAIZ, 'deploy/hml/instalador/nucleo.js'), 'utf8'), /COORDENACAO_NAO_HOMOLOGADA/);
    assert.equal(JSON.parse(fs.readFileSync(path.join(RAIZ, 'deploy/hml/cd/agente.config.backend.exemplo.json'), 'utf8')).habilitado, false);
  });
});
