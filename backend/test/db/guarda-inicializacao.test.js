'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

/**
 * P1 — Guarda de inicialização: antes de subir a API, confere por leitura que
 * o banco é o esperado e que a estrutura está compatível com o código. Nunca
 * executa migration, nunca escreve. Falha fechada: qualquer problema impede a
 * inicialização com mensagem clara.
 */

const RAIZ = path.join(__dirname, '..', '..');
const guarda = () => require('../../src/db/guarda-inicializacao');

const observadoBom = () => ({
  banco: 'gestao_epi_copia_ghe_20261015',
  papel: 'gestao_epi_dev',
  dono: 'gestao_epi_dev',
  porta: 5432,
  migrations: { controleExiste: true, aplicadas: ['000_a', '001_b'], pendentes: [], semArquivo: [], ordemConfere: true, ultima: '001_b' },
  integridade: { integro: true, relatorio: { alteradas: [], renomeadas: [], ausentes: [], novas: [] } },
  sentinelasAusentes: [],
});

// Os nomes de banco abaixo são fixtures dos testes: o código não conhece nenhum banco; a lista permitida vem sempre do ambiente.
const envBom = () => ({ DB_NAME: 'gestao_epi_copia_ghe_20261015', DB_USER: 'gestao_epi_dev', GUARDA_BANCOS_PERMITIDOS: 'gestao_epi_copia_ghe_20261015' });
const semLista = () => { const e = envBom(); delete e.GUARDA_BANCOS_PERMITIDOS; return e; };
const listasNaoConfiguradas = [undefined, '', '   ', ' , ,  ', '\t'];

describe('guarda de inicialização — avaliação (pura)', () => {
  test('aprova o banco listado em GUARDA_BANCOS_PERMITIDOS com tudo em ordem e resume o estado', () => {
    const r = guarda().avaliar({ env: envBom(), observado: observadoBom() });
    assert.equal(r.aprovado, true);
    assert.deepEqual(r.problemas, []);
    assert.match(r.resumo, /gestao_epi_copia_ghe_20261015/);
    assert.match(r.resumo, /2 migrations/);
    assert.match(r.resumo, /001_b/);
  });

  test('nenhum banco é embutido no código: não há constante exportada nem nome de banco no módulo', () => {
    assert.equal(guarda().BANCO_PRINCIPAL_LOCAL, undefined);
    const modulo = fs.readFileSync(path.join(RAIZ, 'src', 'db', 'guarda-inicializacao.js'), 'utf8');
    assert.doesNotMatch(modulo, /gestao_epi_copia_ghe|BANCO_PRINCIPAL_LOCAL/);
    assert.doesNotMatch(modulo, /gestao_epi_[a-z0-9_]+/);
  });

  test('bancosPermitidos devolve só o que está na variável (vírgulas, espaços e itens vazios ignorados) e nada por padrão', () => {
    const { bancosPermitidos } = guarda();
    assert.deepEqual(bancosPermitidos({ GUARDA_BANCOS_PERMITIDOS: ' a_b , c_d ,, ' }), ['a_b', 'c_d']);
    for (const valor of listasNaoConfiguradas) assert.deepEqual(bancosPermitidos({ GUARDA_BANCOS_PERMITIDOS: valor }), [], JSON.stringify(valor));
    assert.deepEqual(bancosPermitidos({}), []);
  });

  test('sem lista configurada (ausente, vazia, só espaços ou só vírgulas) reprova mesmo com o banco igual ao DB_NAME', () => {
    for (const valor of listasNaoConfiguradas) {
      const env = valor === undefined ? semLista() : { ...semLista(), GUARDA_BANCOS_PERMITIDOS: valor };
      const r = guarda().avaliar({ env, observado: observadoBom() });
      assert.equal(r.aprovado, false, JSON.stringify(valor));
      const p = r.problemas.find((x) => x.codigo === 'BANCOS_PERMITIDOS_NAO_CONFIGURADOS');
      assert.ok(p, `deve apontar BANCOS_PERMITIDOS_NAO_CONFIGURADOS para ${JSON.stringify(valor)}`);
      assert.match(p.mensagem, /GUARDA_BANCOS_PERMITIDOS/);
    }
  });

  test('reprova banco fora da lista permitida, nomeando o observado e os permitidos', () => {
    const o = observadoBom(); o.banco = 'gestao_epi_homolog_local';
    const r = guarda().avaliar({ env: { ...envBom(), DB_NAME: 'gestao_epi_homolog_local' }, observado: o });
    assert.equal(r.aprovado, false);
    const p = r.problemas.find((x) => x.codigo === 'BANCO_NAO_PERMITIDO');
    assert.ok(p, 'deve apontar BANCO_NAO_PERMITIDO');
    assert.match(p.mensagem, /gestao_epi_homolog_local/);
    assert.match(p.mensagem, /gestao_epi_copia_ghe_20261015/);
  });

  test('a mensagem de banco não permitido mostra só a lista do ambiente, sem citar nenhum banco do repositório', () => {
    const o = observadoBom(); o.banco = 'banco_b';
    const r = guarda().avaliar({ env: { DB_NAME: 'banco_b', DB_USER: 'gestao_epi_dev', GUARDA_BANCOS_PERMITIDOS: 'banco_a' }, observado: o });
    const p = r.problemas.find((x) => x.codigo === 'BANCO_NAO_PERMITIDO');
    assert.ok(p);
    assert.match(p.mensagem, /banco_b/);
    assert.match(p.mensagem, /banco_a/);
    assert.doesNotMatch(p.mensagem, /copia_ghe/);
  });

  test('GUARDA_BANCOS_PERMITIDOS aceita vários bancos (vírgulas e espaços), sem remover a exigência', () => {
    const o = observadoBom(); o.banco = 'gestao_epi_teste_local';
    const env = { ...envBom(), DB_NAME: 'gestao_epi_teste_local', GUARDA_BANCOS_PERMITIDOS: ' gestao_epi_teste_local , outro ' };
    assert.equal(guarda().avaliar({ env, observado: o }).aprovado, true);
    o.banco = 'gestao_epi_demo';
    assert.equal(guarda().avaliar({ env: { ...env, DB_NAME: 'gestao_epi_demo' }, observado: o }).aprovado, false);
  });

  test('a comparação é exata: curinga, prefixo, sufixo e caixa diferente não autorizam', () => {
    for (const lista of ['*', 'gestao_epi_%', 'gestao_epi_*', 'gestao_epi', 'copia_ghe_20261015', 'GESTAO_EPI_COPIA_GHE_20261015', 'gestao_epi_copia_ghe_2026101']) {
      const r = guarda().avaliar({ env: { ...envBom(), GUARDA_BANCOS_PERMITIDOS: lista }, observado: observadoBom() });
      assert.equal(r.aprovado, false, lista);
      assert.ok(r.problemas.some((x) => x.codigo === 'BANCO_NAO_PERMITIDO'), lista);
    }
  });

  test('reprova quando o banco conectado difere do DB_NAME pedido', () => {
    const o = observadoBom();
    const r = guarda().avaliar({ env: { ...envBom(), DB_NAME: 'gestao_epi_outro' }, observado: o });
    assert.equal(r.aprovado, false);
    assert.ok(r.problemas.some((x) => x.codigo === 'BANCO_DIFERENTE_DO_PEDIDO' || x.codigo === 'BANCO_NAO_PERMITIDO'));
  });

  test('reprova papel diferente do DB_USER', () => {
    const o = observadoBom(); o.papel = 'postgres';
    const r = guarda().avaliar({ env: envBom(), observado: o });
    assert.equal(r.aprovado, false);
    assert.ok(r.problemas.some((x) => x.codigo === 'PAPEL_INESPERADO'));
  });

  test('reprova migrations pendentes e lista cada uma na mensagem', () => {
    const o = observadoBom(); o.migrations.pendentes = ['088_x', '089_token_dispositivos_queda_suspeita'];
    const r = guarda().avaliar({ env: envBom(), observado: o });
    assert.equal(r.aprovado, false);
    const p = r.problemas.find((x) => x.codigo === 'MIGRATIONS_PENDENTES');
    assert.ok(p);
    assert.match(p.mensagem, /089_token_dispositivos_queda_suspeita/);
    assert.match(p.mensagem, /088_x/);
    assert.match(p.mensagem, /npm run db:migrate/, 'orienta o caminho oficial sem executá-lo');
  });

  test('reprova migrations registradas sem arquivo (banco à frente do código)', () => {
    const o = observadoBom(); o.migrations.semArquivo = ['090_futura'];
    const r = guarda().avaliar({ env: envBom(), observado: o });
    assert.equal(r.aprovado, false);
    assert.ok(r.problemas.some((x) => x.codigo === 'MIGRATIONS_SEM_ARQUIVO' && /090_futura/.test(x.mensagem)));
  });

  test('reprova tabela de controle ausente e ordem divergente', () => {
    const o1 = observadoBom(); o1.migrations.controleExiste = false; o1.migrations.aplicadas = [];
    assert.ok(guarda().avaliar({ env: envBom(), observado: o1 }).problemas.some((x) => x.codigo === 'CONTROLE_AUSENTE'));
    const o2 = observadoBom(); o2.migrations.ordemConfere = false;
    assert.ok(guarda().avaliar({ env: envBom(), observado: o2 }).problemas.some((x) => x.codigo === 'ORDEM_DIVERGENTE'));
  });

  test('reprova sentinela estrutural ausente, nomeando a migration', () => {
    const o = observadoBom(); o.sentinelasAusentes = [{ migration: '089_token_dispositivos_queda_suspeita', tabela: 'token_dispositivos', coluna: 'queda_suspeita_desde' }];
    const r = guarda().avaliar({ env: envBom(), observado: o });
    assert.equal(r.aprovado, false);
    const p = r.problemas.find((x) => x.codigo === 'ESTRUTURA_INCOMPATIVEL');
    assert.ok(p);
    assert.match(p.mensagem, /token_dispositivos\.queda_suspeita_desde/);
    assert.match(p.mensagem, /089_token_dispositivos_queda_suspeita/);
  });

  test('reprova manifesto de checksums divergente', () => {
    const o = observadoBom(); o.integridade = { integro: false, relatorio: { alteradas: [{ nome: '089_x' }], renomeadas: [], ausentes: [], novas: [] } };
    const r = guarda().avaliar({ env: envBom(), observado: o });
    assert.ok(r.problemas.some((x) => x.codigo === 'MANIFESTO_DIVERGENTE' && /089_x/.test(x.mensagem)));
  });

  test('acumula todos os problemas de uma vez (não para no primeiro)', () => {
    const o = observadoBom(); o.banco = 'gestao_epi_demo'; o.migrations.pendentes = ['089_z']; o.sentinelasAusentes = [{ migration: '084_a', tabela: 'funcionarios', coluna: 'situacao' }];
    const r = guarda().avaliar({ env: { ...envBom(), DB_NAME: 'gestao_epi_demo' }, observado: o });
    assert.ok(r.problemas.length >= 3);
  });
});

describe('guarda de inicialização — sentinelas', () => {
  test('cada sentinela aponta uma migration existente no repositório e a 089 está coberta', () => {
    const { SENTINELAS } = guarda();
    const arquivos = fs.readdirSync(path.join(RAIZ, 'migrations')).filter((f) => /^\d{3}_[a-z0-9_]+\.sql$/.test(f)).map((f) => f.replace(/\.sql$/, ''));
    assert.ok(SENTINELAS.length >= 4);
    for (const s of SENTINELAS) {
      assert.ok(arquivos.includes(s.migration), `migration da sentinela inexistente: ${s.migration}`);
      assert.match(s.tabela, /^[a-z_]+$/);
      if (s.coluna !== null) assert.match(s.coluna, /^[a-z_]+$/);
    }
    assert.ok(SENTINELAS.some((s) => s.tabela === 'token_dispositivos' && s.coluna === 'queda_suspeita_desde'));
  });
});

describe('guarda de inicialização — coleta (somente leitura)', () => {
  function clienteFalso(respostas) {
    const sql = [];
    return {
      sql,
      async query(texto, params) {
        sql.push(String(texto).trim());
        for (const [padrao, linhas] of respostas) if (padrao.test(texto)) return { rows: typeof linhas === 'function' ? linhas(params) : linhas };
        return { rows: [] };
      },
    };
  }

  test('só emite BEGIN READ ONLY, SELECT e ROLLBACK, e devolve o observado', async () => {
    const client = clienteFalso([
      [/current_database/, [{ banco: 'gestao_epi_copia_ghe_20261015', papel: 'gestao_epi_dev', dono: 'gestao_epi_dev', porta: 5432 }]],
      [/ORDER BY run_on, id/, [{ name: '000_a' }, { name: '001_b' }]],
      [/information_schema\.columns/, (params) => (params[params.length - 1] === 'queda_suspeita_desde' ? [] : [{ ok: 1 }])],
      [/information_schema\.tables|to_regclass/, [{ ok: 1 }]],
    ]);
    const inspecionar = async () => ({ controleExiste: true, schemaTemObjetos: true, aplicadas: ['000_a', '001_b'], pendentes: [], semArquivo: [] });
    const arquivos = ['000_a', '001_b'];
    const o = await guarda().coletar({ client, inspecionar, arquivos, sentinelas: [{ migration: '089_x', tabela: 'token_dispositivos', coluna: 'queda_suspeita_desde' }, { migration: '084_y', tabela: 'funcionarios', coluna: 'situacao' }], integridade: () => ({ integro: true, relatorio: {} }) });
    assert.equal(o.banco, 'gestao_epi_copia_ghe_20261015');
    assert.equal(o.papel, 'gestao_epi_dev');
    assert.equal(o.migrations.ordemConfere, true);
    assert.equal(o.migrations.ultima, '001_b');
    assert.deepEqual(o.sentinelasAusentes.map((s) => s.coluna), ['queda_suspeita_desde']);
    assert.equal(client.sql[0], 'BEGIN READ ONLY');
    assert.equal(client.sql[client.sql.length - 1], 'ROLLBACK');
    for (const s of client.sql.slice(1, -1)) assert.match(s, /^(SELECT|SET LOCAL)\b/i, `consulta fora do contrato de leitura: ${s}`);
    assert.ok(!client.sql.some((s) => /\b(INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE|COMMIT)\b/i.test(s)));
  });

  test('ordem run_on,id diferente dos arquivos reprova', async () => {
    const client = clienteFalso([
      [/current_database/, [{ banco: 'gestao_epi_copia_ghe_20261015', papel: 'gestao_epi_dev', dono: 'gestao_epi_dev', porta: 5432 }]],
      [/ORDER BY run_on, id/, [{ name: '001_b' }, { name: '000_a' }]],
      [/information_schema/, [{ ok: 1 }]],
    ]);
    const inspecionar = async () => ({ controleExiste: true, schemaTemObjetos: true, aplicadas: ['000_a', '001_b'], pendentes: [], semArquivo: [] });
    const o = await guarda().coletar({ client, inspecionar, arquivos: ['000_a', '001_b'], sentinelas: [], integridade: () => ({ integro: true, relatorio: {} }) });
    assert.equal(o.migrations.ordemConfere, false);
  });

  test('faz ROLLBACK mesmo quando uma consulta falha', async () => {
    const client = clienteFalso([[/current_database/, () => { throw new Error('falha simulada'); }]]);
    await assert.rejects(guarda().coletar({ client, inspecionar: async () => ({ controleExiste: true, aplicadas: [], pendentes: [], semArquivo: [] }), arquivos: [], sentinelas: [], integridade: () => ({ integro: true, relatorio: {} }) }));
    assert.equal(client.sql[client.sql.length - 1], 'ROLLBACK');
  });
});

describe('guarda de inicialização — executar (CLI)', () => {
  const linhas = () => { const l = []; return { l, saida: { log: (...a) => l.push(a.join(' ')), error: (...a) => l.push(a.join(' ')) } }; };
  // Pasta de migrations válida e isolada: o working tree local pode conter cópias " 2", que a guarda reprova de propósito.
  const dirValido = (t) => { const d = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'guarda-ok-')); fs.writeFileSync(path.join(d, '000_inicial.sql'), 'SELECT 1;'); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };

  test('devolve 0 e imprime GUARDA APROVADA quando tudo confere', async (t) => {
    const { l, saida } = linhas();
    const codigo = await guarda().executar({ env: envBom(), saida, diretorio: dirValido(t), coletar: async () => observadoBom(), criarCliente: () => ({ connect: async () => {}, end: async () => {} }) });
    assert.equal(codigo, guarda().SAIDAS.OK);
    assert.ok(l.some((x) => /GUARDA APROVADA/.test(x)));
  });

  test('devolve 3 e imprime GUARDA REPROVADA com cada problema quando há divergência', async (t) => {
    const { l, saida } = linhas();
    const o = observadoBom(); o.migrations.pendentes = ['089_token_dispositivos_queda_suspeita'];
    const codigo = await guarda().executar({ env: envBom(), saida, diretorio: dirValido(t), coletar: async () => o, criarCliente: () => ({ connect: async () => {}, end: async () => {} }) });
    assert.equal(codigo, guarda().SAIDAS.REPROVADA);
    assert.ok(l.some((x) => /GUARDA REPROVADA/.test(x)));
    assert.ok(l.some((x) => /089_token_dispositivos_queda_suspeita/.test(x)));
    assert.ok(l.some((x) => /nao foi iniciad|não foi iniciad/i.test(x)));
  });

  test('devolve 1 quando não consegue conectar e nunca expõe a senha', async (t) => {
    const { l, saida } = linhas();
    const env = { ...envBom(), DB_PASSWORD: 'segredo-que-nao-pode-aparecer' };
    const codigo = await guarda().executar({ env, saida, diretorio: dirValido(t), coletar: async () => observadoBom(), criarCliente: () => ({ connect: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); }, end: async () => {} }) });
    assert.equal(codigo, guarda().SAIDAS.ERRO);
    assert.ok(!l.join('\n').includes('segredo-que-nao-pode-aparecer'));
    assert.ok(l.some((x) => /ECONNREFUSED/.test(x)));
  });

  test('reprova (3), sem conectar, quando a pasta de migrations tem arquivo fora do padrão, nomeando o arquivo', async () => {
    const os = require('node:os');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guarda-mig-'));
    fs.writeFileSync(path.join(dir, '000_inicial.sql'), 'SELECT 1;');
    fs.writeFileSync(path.join(dir, '000_inicial 2.sql'), 'SELECT 1;');
    let conectou = false;
    const { l, saida } = linhas();
    const codigo = await guarda().executar({ env: envBom(), saida, diretorio: dir, criarCliente: () => ({ connect: async () => { conectou = true; }, end: async () => {} }) });
    assert.equal(codigo, guarda().SAIDAS.REPROVADA);
    assert.equal(conectou, false);
    assert.ok(l.some((x) => /MIGRATIONS_DIRETORIO_INVALIDO/.test(x) && /000_inicial 2\.sql/.test(x)));
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('encerra a conexão também quando a coleta falha', async (t) => {
    let encerrou = 0;
    const { saida } = linhas();
    const codigo = await guarda().executar({ env: envBom(), saida, diretorio: dirValido(t), coletar: async () => { throw new Error('x'); }, criarCliente: () => ({ connect: async () => {}, end: async () => { encerrou++; } }) });
    assert.equal(codigo, guarda().SAIDAS.ERRO);
    assert.equal(encerrou, 1);
  });

  test('reprova (3), antes de criar o cliente e de conectar, quando GUARDA_BANCOS_PERMITIDOS não está configurada', async (t) => {
    for (const valor of listasNaoConfiguradas) {
      let criou = 0;
      let conectou = 0;
      let coletou = 0;
      const { l, saida } = linhas();
      const env = { ...semLista(), DB_PASSWORD: 'segredo-que-nao-pode-aparecer' };
      if (valor !== undefined) env.GUARDA_BANCOS_PERMITIDOS = valor;
      const codigo = await guarda().executar({
        env,
        saida,
        diretorio: dirValido(t),
        coletar: async () => { coletou++; return observadoBom(); },
        criarCliente: () => { criou++; return { connect: async () => { conectou++; }, end: async () => {} }; },
      });
      const rotulo = JSON.stringify(valor);
      assert.equal(codigo, guarda().SAIDAS.REPROVADA, rotulo);
      assert.deepEqual([criou, conectou, coletou], [0, 0, 0], `${rotulo}: não pode criar cliente, conectar nem coletar`);
      const texto = l.join('\n');
      assert.match(texto, /GUARDA REPROVADA/);
      assert.match(texto, /BANCOS_PERMITIDOS_NAO_CONFIGURADOS/);
      assert.match(texto, /GUARDA_BANCOS_PERMITIDOS/);
      assert.match(texto, /nao foi iniciad|não foi iniciad/i);
      assert.ok(!texto.includes('segredo-que-nao-pode-aparecer'));
    }
  });

  test('com a lista configurada conecta uma vez, e banco fora da lista reprova (3) depois da leitura', async (t) => {
    let criou = 0;
    const { saida } = linhas();
    const fabrica = () => { criou++; return { connect: async () => {}, end: async () => {} }; };
    const ok = await guarda().executar({ env: envBom(), saida, diretorio: dirValido(t), coletar: async () => observadoBom(), criarCliente: fabrica });
    assert.equal(ok, guarda().SAIDAS.OK);
    assert.equal(criou, 1);
    const fora = observadoBom(); fora.banco = 'banco_de_outro_ambiente';
    const reprovado = await guarda().executar({ env: { ...envBom(), DB_NAME: 'banco_de_outro_ambiente' }, saida, diretorio: dirValido(t), coletar: async () => fora, criarCliente: fabrica });
    assert.equal(reprovado, guarda().SAIDAS.REPROVADA);
  });
});

describe('guarda de inicialização — documentação da variável', () => {
  const exemplo = fs.readFileSync(path.join(RAIZ, '.env.example'), 'utf8');

  test('.env.example documenta GUARDA_BANCOS_PERMITIDOS só como exemplo comentado, sem valor real e sem definir a variável', () => {
    const linhas = exemplo.split('\n');
    assert.ok(linhas.some((x) => /^#\s*GUARDA_BANCOS_PERMITIDOS=/.test(x)), 'exemplo comentado ausente');
    assert.ok(!linhas.some((x) => /^\s*GUARDA_BANCOS_PERMITIDOS\s*=/.test(x)), 'a variável não pode estar definida (descomentada) no exemplo');
    assert.doesNotMatch(exemplo, /gestao_epi_copia_ghe/, 'o banco local de uma pessoa não entra no exemplo');
    assert.match(exemplo, /npm start/);
  });

  test('o comentário do K5 (SameSite=Strict do cookie do tablet) continua no .env.example', () => {
    assert.match(exemplo, /SameSite é sempre Strict\n# e NÃO depende de SESSAO_COOKIE_SAMESITE \(K5-A\)/);
  });
});

describe('guarda de inicialização — biblioteca padrão de imagens (opt-in)', () => {
  const linhas = () => { const l = []; return { l, saida: { log: (...a) => l.push(a.join(' ')), error: (...a) => l.push(a.join(' ')) } }; };
  const dirValido = (t) => { const d = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'guarda-bib-')); fs.writeFileSync(path.join(d, '000_inicial.sql'), 'SELECT 1;'); t.after(() => fs.rmSync(d, { recursive: true, force: true })); return d; };
  const clienteFalso = () => ({ connect: async () => {}, end: async () => {} });
  const comPolitica = (valor) => ({ ...envBom(), IMAGENS_BIBLIOTECA_PADRAO: valor });
  /** Espiona a verificação da biblioteca: devolve o resultado combinado ou lança. */
  const biblioteca = (resposta) => {
    const chamadas = [];
    const verificarBiblioteca = async (argumentos) => {
      chamadas.push(argumentos);
      if (resposta instanceof Error) throw resposta;
      return resposta;
    };
    return { chamadas, verificarBiblioteca };
  };
  const SEM_PROBLEMA = { problemas: [], resumo: { registrosPadrao: 31, veredito: 'INTEGRO' } };
  const AUSENTE = { problemas: [{ codigo: 'BIBLIOTECA_IMAGENS_AUSENTE', mensagem: 'nenhuma imagem padrão registrada no banco' }], resumo: { registrosPadrao: 0, veredito: 'INTEGRO' } };
  const INCONSISTENTE = { problemas: [{ codigo: 'BIBLIOTECA_IMAGENS_INCONSISTENTE', mensagem: 'a biblioteca padrão não está íntegra (veredito INVESTIGAR)' }], resumo: { registrosPadrao: 31, veredito: 'INVESTIGAR' } };
  const executar = (t, env, espiao, extra = {}) => {
    const { l, saida } = linhas();
    const promessa = guarda().executar({
      env, saida, diretorio: dirValido(t), coletar: async () => observadoBom(), criarCliente: clienteFalso, verificarBiblioteca: espiao.verificarBiblioteca, ...extra,
    });
    return { l, promessa };
  };

  test('politicaDaBiblioteca: ausente, vazia ou só espaços = sem exigência; os dois valores exatos; qualquer outro = inválida', () => {
    const { politicaDaBiblioteca } = guarda();
    for (const valor of [undefined, null, '', '   ', '\t']) assert.equal(politicaDaBiblioteca({ IMAGENS_BIBLIOTECA_PADRAO: valor }), null, JSON.stringify(valor));
    assert.equal(politicaDaBiblioteca({}), null);
    assert.equal(politicaDaBiblioteca({ IMAGENS_BIBLIOTECA_PADRAO: 'obrigatoria' }), 'obrigatoria');
    assert.equal(politicaDaBiblioteca({ IMAGENS_BIBLIOTECA_PADRAO: 'desabilitada' }), 'desabilitada');
    for (const valor of ['Obrigatoria', 'OBRIGATORIA', 'obrigatória', ' obrigatoria', 'obrigatoria ', 'true', '1', 'ativo', 'desabilitada,obrigatoria']) {
      assert.equal(politicaDaBiblioteca({ IMAGENS_BIBLIOTECA_PADRAO: valor }), 'invalida', valor);
    }
  });

  test('os valores da política da guarda são os do serviço de prontidão (uma só definição)', () => {
    const { POLITICAS, POLITICA_VARIAVEL } = require('../../src/services/imagem-biblioteca-prontidao.service');
    assert.equal(guarda().VARIAVEL_BIBLIOTECA_IMAGENS, POLITICA_VARIAVEL);
    assert.equal(guarda().politicaDaBiblioteca({ [POLITICA_VARIAVEL]: POLITICAS.OBRIGATORIA }), 'obrigatoria');
    assert.equal(guarda().politicaDaBiblioteca({ [POLITICA_VARIAVEL]: POLITICAS.DESABILITADA }), 'desabilitada');
  });

  test('avaliação: sem política ou desabilitada o resultado é idêntico ao de antes (aprovado, mesmo resumo, nenhum problema novo)', () => {
    const base = guarda().avaliar({ env: envBom(), observado: observadoBom() });
    for (const valor of [undefined, '', '   ', 'desabilitada']) {
      const env = valor === undefined ? envBom() : comPolitica(valor);
      assert.deepEqual(guarda().avaliar({ env, observado: observadoBom() }), base, JSON.stringify(valor));
    }
    assert.doesNotMatch(base.resumo, /biblioteca/);
  });

  test('avaliação: política inválida reprova sem repetir o valor recebido', () => {
    const r = guarda().avaliar({ env: comPolitica('segredo-do-operador'), observado: observadoBom() });
    assert.equal(r.aprovado, false);
    assert.deepEqual(r.problemas.map((p) => p.codigo), ['BIBLIOTECA_IMAGENS_POLITICA_INVALIDA']);
    assert.doesNotMatch(JSON.stringify(r), /segredo-do-operador/);
  });

  test('avaliação: os problemas da biblioteca se somam aos demais e o resumo mostra a biblioteca', () => {
    const observado = { ...observadoBom(), biblioteca: INCONSISTENTE };
    observado.migrations = { ...observado.migrations, pendentes: ['089_token_dispositivos_queda_suspeita'] };
    const r = guarda().avaliar({ env: comPolitica('obrigatoria'), observado });
    assert.deepEqual(r.problemas.map((p) => p.codigo), ['MIGRATIONS_PENDENTES', 'BIBLIOTECA_IMAGENS_INCONSISTENTE']);
    assert.match(r.resumo, /biblioteca de imagens padrão: 31 registro\(s\), armazenamento INVESTIGAR/);
  });

  test('COMPATIBILIDADE: sem a variável (ou vazia, ou desabilitada) a guarda aprova como antes e NÃO consulta a biblioteca', async (t) => {
    for (const valor of [undefined, '', '   ', 'desabilitada']) {
      const espiao = biblioteca(SEM_PROBLEMA);
      const { l, promessa } = executar(t, valor === undefined ? envBom() : comPolitica(valor), espiao);
      assert.equal(await promessa, guarda().SAIDAS.OK, JSON.stringify(valor));
      assert.deepEqual(espiao.chamadas, [], 'a biblioteca não pode ser consultada');
      assert.ok(l.some((x) => /GUARDA APROVADA/.test(x)));
      assert.ok(!l.join('\n').includes('biblioteca'));
    }
  });

  test('COMPATIBILIDADE: um ambiente sem a exigência com a biblioteca VAZIA continua subindo (a exigência é opt-in)', async (t) => {
    const espiao = biblioteca(AUSENTE);
    const { promessa } = executar(t, envBom(), espiao);
    assert.equal(await promessa, guarda().SAIDAS.OK);
    assert.deepEqual(espiao.chamadas, []);
  });

  test('biblioteca obrigatória ÍNTEGRA: aprova (0), consulta uma vez com o ambiente e o cliente da guarda e registra o resumo', async (t) => {
    const espiao = biblioteca(SEM_PROBLEMA);
    const env = comPolitica('obrigatoria');
    const { l, promessa } = executar(t, env, espiao);
    assert.equal(await promessa, guarda().SAIDAS.OK);
    assert.equal(espiao.chamadas.length, 1);
    assert.equal(espiao.chamadas[0].ambiente, env);
    assert.equal(typeof espiao.chamadas[0].cliente.connect, 'function');
    assert.ok(l.some((x) => /biblioteca de imagens padrão: 31 registro\(s\), armazenamento INTEGRO/.test(x)));
    assert.ok(l.some((x) => /GUARDA APROVADA/.test(x)));
  });

  test('biblioteca obrigatória AUSENTE: reprova (3), diz que o backend NÃO foi iniciado e orienta a instalação', async (t) => {
    const espiao = biblioteca(AUSENTE);
    const { l, promessa } = executar(t, comPolitica('obrigatoria'), espiao);
    assert.equal(await promessa, guarda().SAIDAS.REPROVADA);
    const texto = l.join('\n');
    assert.match(texto, /GUARDA REPROVADA/);
    assert.match(texto, /BIBLIOTECA_IMAGENS_AUSENTE/);
    assert.match(texto, /não foi iniciado|NÃO foi iniciado/i);
    assert.doesNotMatch(texto, /GUARDA APROVADA/);
  });

  test('biblioteca obrigatória INCONSISTENTE: reprova (3) com o problema nomeado', async (t) => {
    const espiao = biblioteca(INCONSISTENTE);
    const { l, promessa } = executar(t, comPolitica('obrigatoria'), espiao);
    assert.equal(await promessa, guarda().SAIDAS.REPROVADA);
    assert.match(l.join('\n'), /BIBLIOTECA_IMAGENS_INCONSISTENTE/);
  });

  test('biblioteca obrigatória: falha ao verificar a biblioteca é erro técnico (1), falha fechada, e a conexão é encerrada', async (t) => {
    const espiao = biblioteca(Object.assign(new Error('falha de leitura'), { code: 'XX000' }));
    let encerrada = false;
    const { l, promessa } = executar(t, comPolitica('obrigatoria'), espiao, { criarCliente: () => ({ connect: async () => {}, end: async () => { encerrada = true; } }) });
    assert.equal(await promessa, guarda().SAIDAS.ERRO);
    assert.match(l.join('\n'), /o backend NÃO foi iniciado/);
    assert.equal(encerrada, true);
  });

  test('banco já reprovado (migration pendente): a biblioteca nem é consultada e o motivo real é mostrado', async (t) => {
    const espiao = biblioteca(AUSENTE);
    const observado = observadoBom();
    observado.migrations.pendentes = ['089_token_dispositivos_queda_suspeita'];
    const { l, promessa } = executar(t, comPolitica('obrigatoria'), espiao, { coletar: async () => observado });
    assert.equal(await promessa, guarda().SAIDAS.REPROVADA);
    assert.deepEqual(espiao.chamadas, []);
    assert.match(l.join('\n'), /MIGRATIONS_PENDENTES/);
  });

  test('política inválida reprova (3) sem consultar a biblioteca', async (t) => {
    const espiao = biblioteca(SEM_PROBLEMA);
    const { l, promessa } = executar(t, comPolitica('talvez'), espiao);
    assert.equal(await promessa, guarda().SAIDAS.REPROVADA);
    assert.deepEqual(espiao.chamadas, []);
    assert.match(l.join('\n'), /BIBLIOTECA_IMAGENS_POLITICA_INVALIDA/);
    assert.doesNotMatch(l.join('\n'), /talvez/);
  });

  test('o módulo da guarda só carrega o serviço da biblioteca dentro de executar (sem custo nem dependência para quem não exige)', () => {
    const modulo = fs.readFileSync(path.join(RAIZ, 'src', 'db', 'guarda-inicializacao.js'), 'utf8');
    const ocorrencias = modulo.split('\n').filter((linha) => /imagem-biblioteca-prontidao/.test(linha) && /require\(/.test(linha));
    assert.equal(ocorrencias.length, 1);
    assert.match(ocorrencias[0], /^\s{2,}/, 'o require da biblioteca não pode estar no topo do módulo');
    assert.doesNotMatch(modulo, /\.zip|pacote-padrao|imagem-padrao-importacao|plano-pacotes/i, 'a inicialização não depende de ZIP, de pacote nem do importador');
  });
});

describe('guarda de inicialização — integração nos scripts npm', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));

  test('start e dev executam a guarda ANTES do servidor, encadeados com &&', () => {
    for (const nome of ['start', 'dev']) {
      const s = pkg.scripts[nome];
      assert.match(s, /^node --require dotenv\/config scripts\/guarda-inicializacao\.js && /, `script ${nome}: ${s}`);
      assert.match(s, /src\/server\.js$/);
    }
  });

  test('existe o script CLI e ele não carrega app, server, pool nem módulos de escrita', () => {
    const cli = fs.readFileSync(path.join(RAIZ, 'scripts', 'guarda-inicializacao.js'), 'utf8');
    assert.match(cli, /guarda-inicializacao/);
    assert.doesNotMatch(cli, /src\/app|src\/server|config\/database/);
    const modulo = fs.readFileSync(path.join(RAIZ, 'src', 'db', 'guarda-inicializacao.js'), 'utf8');
    assert.doesNotMatch(modulo, /aplicarMigrations|pg_restore|DROP|TRUNCATE|INSERT INTO|UPDATE |DELETE FROM/);
  });

  test('server.js e app.js continuam sem a guarda (os testes que sobem o servidor real não dependem de banco)', () => {
    for (const rel of ['src/server.js', 'src/app.js']) {
      assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, rel), 'utf8'), /guarda-inicializacao/);
    }
  });
});
