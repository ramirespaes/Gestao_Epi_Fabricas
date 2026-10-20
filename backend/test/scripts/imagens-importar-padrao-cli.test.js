'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const h = require('../helpers/pacote-padrao-ficticio');
const { poolProibido, armazenamentoProibido } = require('../helpers/instrumentacao-importacao');
const {
  pacote, ZIP_INTEGRO, item, ADULTERACOES, MANIFESTOS_INVALIDOS, HOSTIS, FORMATOS,
} = require('../helpers/cenarios-importacao-padrao');

/**
 * Importação da biblioteca padrão (Biblioteca de Imagens, Unidade 5A-2, RED): INTERFACE DE LINHA DE COMANDO, sem banco.
 *
 * Módulo previsto: scripts/imagens-importar-padrao.js, na família de scripts/provisionar-permissoes-master.js (Node autônomo, executado por um operador,
 * credenciais só pelo ambiente, nada de segredo em argumento, URL ou saída). O comportamento com banco e armazenamento reais está em
 * test/integracao/imagens-importar-padrao.integration.js (CLI-DB-*).
 *
 *   node scripts/imagens-importar-padrao.js --pacote <zip absoluto> --sha256 <hash aprovado do ZIP> [--mapeamento <csv absoluto>] [--verificar | --dry-run | --executar]
 *
 *   - `--sha256` é obrigatório em todos os modos: o hash aprovado do ZIP vem de FORA do pacote (é a âncora que o manifesto do próprio pacote não pode ser).
 *   - Modos mutuamente exclusivos. `--verificar`: só confere o pacote, NUNCA toca banco nem armazenamento. `--dry-run` (também o padrão quando nenhum modo é
 *     dado): confere o pacote, lê o estado e relata o que seria feito, sem escrever. `--executar`: grava. Seguro por padrão: sem `--executar`, nada é gravado.
 *   - `--mapeamento` não se aplica a `--verificar` (as sugestões de tipo são do banco).
 *   - interpretarArgumentos(argv) -> { ok: true, pacote, sha256, mapeamento|null, modo: 'VERIFICAR'|'SIMULAR'|'EXECUTAR' } | { ok: false, erro }; erro nunca ecoa o valor recebido.
 *   - executarComando({ pacote, sha256, mapeamento, modo }, { pool, armazenamento, saida }) -> Promise<{ saida: <código>, resultado }>. Em VERIFICAR, pool e armazenamento
 *     não são usados. Erros inesperados (que não são do serviço) propagam.
 *   - Códigos de saída: OK=0, ERRO=1, ARGUMENTOS=2, INTEGRIDADE=3 (o pacote não foi comprovado: PACOTE_* e IMAGEM_PADRAO_INVALIDA, menos PACOTE_ARGUMENTOS_INVALIDOS,
 *     que é ARGUMENTOS; MAPEAMENTO_INVALIDO e MAPEAMENTO_INDISPONIVEL também são ARGUMENTOS, porque o CSV é entrada do operador), DIVERGENCIA=4 (ESTADO_DIVERGENTE: o banco
 *     ou o armazenamento já têm outra coisa; nada foi alterado).
 *   - A saída (log e erro) nunca leva caminho absoluto, segredo, nem caractere de controle vindo do ZIP (um nome de entrada hostil não injeta sequência de terminal).
 */

const SCRIPT = path.join(__dirname, '..', '..', 'scripts', 'imagens-importar-padrao.js');
const NOME_ZIP = 'Pacote_Ficticio_30_EPIs.zip';
const SEGREDO = 'SEGREDO-DO-AMBIENTE-DO-TESTE-CLI-7731';
const CLI = () => exigirModulo('scripts/imagens-importar-padrao');

const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });

/** ZIP numa pasta própria; devolve caminho, pasta e SHA-256. */
function caso(zip) {
  const dir = criarRaizTemporaria();
  raizes.push(dir);
  const pasta = path.join(dir, 'pacote');
  fs.mkdirSync(pasta);
  return { dir, pasta, zip: h.gravarArquivo(pasta, NOME_ZIP, zip), sha: h.sha256(zip) };
}

function capturar() {
  const linhas = [];
  const guardar = (...partes) => { linhas.push(partes.map(String).join(' ')); };
  return { saida: { log: guardar, error: guardar }, linhas, texto: () => linhas.join('\n') };
}

const SEM_CONTROLE = /(?!\n)\p{Cc}/u;
const limpa = (texto, c) => {
  assert.equal(texto.includes(c.dir), false, 'a saída vaza o caminho do pacote');
  assert.equal(texto.includes(SEGREDO), false, 'a saída vaza um segredo do ambiente');
  assert.doesNotMatch(texto, SEM_CONTROLE, 'a saída leva caractere de controle');
};

const verificarComando = (c, extra = {}) => {
  const banco = poolProibido();
  const disco = armazenamentoProibido();
  const capturada = capturar();
  const chamada = CLI().executarComando({ pacote: c.zip, sha256: c.sha, mapeamento: null, modo: 'VERIFICAR', ...extra }, { pool: banco.pool, armazenamento: disco.armazenamento, saida: capturada.saida });
  return { chamada, capturada, sql: banco.registros, armazenamento: disco.registros };
};

describe('[CLI-PAD] argumentos, uso e códigos de saída', () => {
  const SHA = 'a'.repeat(64);
  const ZIP = '/tmp/gepi-pacote-qualquer.zip';
  const MAPA = '/tmp/gepi-mapeamento-qualquer.csv';
  const base = ['--pacote', ZIP, '--sha256', SHA];

  test('CLI-PAD-01 — os códigos de saída são exatamente OK=0, ERRO=1, ARGUMENTOS=2, INTEGRIDADE=3, DIVERGENCIA=4 (congelados), e o módulo expõe a interface prevista', () => {
    const cli = CLI();
    assert.deepEqual(cli.SAIDAS, { OK: 0, ERRO: 1, ARGUMENTOS: 2, INTEGRIDADE: 3, DIVERGENCIA: 4 });
    assert.equal(Object.isFrozen(cli.SAIDAS), true);
    for (const nome of ['interpretarArgumentos', 'executarComando', 'uso']) assert.equal(typeof cli[nome], 'function', nome);
  });

  test('CLI-PAD-02 — argumentos válidos: o modo padrão é SIMULAR (nunca grava sem --executar), --dry-run é o mesmo, a ordem dos argumentos não importa', () => {
    const { interpretarArgumentos } = CLI();
    assert.deepEqual(interpretarArgumentos(base), { ok: true, pacote: ZIP, sha256: SHA, mapeamento: null, modo: 'SIMULAR' });
    assert.deepEqual(interpretarArgumentos([...base, '--dry-run']), { ok: true, pacote: ZIP, sha256: SHA, mapeamento: null, modo: 'SIMULAR' });
    assert.deepEqual(interpretarArgumentos([...base, '--verificar']), { ok: true, pacote: ZIP, sha256: SHA, mapeamento: null, modo: 'VERIFICAR' });
    assert.deepEqual(interpretarArgumentos([...base, '--executar']), { ok: true, pacote: ZIP, sha256: SHA, mapeamento: null, modo: 'EXECUTAR' });
    assert.deepEqual(interpretarArgumentos([...base, '--mapeamento', MAPA, '--executar']), { ok: true, pacote: ZIP, sha256: SHA, mapeamento: MAPA, modo: 'EXECUTAR' });
    assert.deepEqual(interpretarArgumentos(['--executar', '--sha256', SHA, '--mapeamento', MAPA, '--pacote', ZIP]), { ok: true, pacote: ZIP, sha256: SHA, mapeamento: MAPA, modo: 'EXECUTAR' });
  });

  test('CLI-PAD-03 — argumentos inválidos são recusados sem ecoar o valor recebido: sem pacote ou hash, caminho relativo, hash malformado, valor ausente, repetição, desconhecido, modos juntos, mapeamento com --verificar', () => {
    const { interpretarArgumentos } = CLI();
    const invalidos = [
      [], ['--pacote', ZIP], ['--sha256', SHA], ['--pacote', 'relativo/segredo-pacote.zip', '--sha256', SHA], [...base, '--mapeamento', 'relativo/segredo-mapa.csv'],
      ['--pacote', ZIP, '--sha256', SHA.toUpperCase()], ['--pacote', ZIP, '--sha256', SHA.slice(1)], ['--pacote', ZIP, '--sha256', `${SHA} `], ['--pacote', ZIP, '--sha256'], ['--pacote', '--sha256', SHA],
      ['--pacote', ZIP, '--pacote', ZIP, '--sha256', SHA], [...base, '--sha256', SHA], [...base, '--mapeamento', MAPA, '--mapeamento', MAPA],
      [...base, '--todas'], [...base, 'posicional'], [...base, '--dry-run', '--executar'], [...base, '--verificar', '--executar'], [...base, '--verificar', '--dry-run'],
      [...base, '--verificar', '--mapeamento', MAPA], ['--pacote', `${ZIP}\0.zip`, '--sha256', SHA],
    ];
    for (const argumentos of invalidos) {
      const r = interpretarArgumentos(argumentos);
      assert.equal(r.ok, false, JSON.stringify(argumentos));
      assert.equal(typeof r.erro, 'string');
      for (const eco of ['segredo-pacote', 'segredo-mapa', SHA, ZIP, MAPA]) assert.equal(r.erro.includes(eco), false, `${JSON.stringify(argumentos)}: o erro ecoa "${eco}"`);
    }
    assert.throws(() => interpretarArgumentos('--pacote x'), TypeError);
  });

  test('CLI-PAD-04 — o texto de uso cita todos os argumentos e o modo seguro por padrão', () => {
    const texto = CLI().uso();
    for (const flag of ['--pacote', '--sha256', '--mapeamento', '--verificar', '--dry-run', '--executar']) assert.ok(texto.includes(flag), flag);
    assert.doesNotMatch(texto, /senha|password|segredo/i, 'o uso não induz a passar segredo');
  });
});

describe('[CLI-PAD] --verificar: confere o pacote sem tocar banco nem armazenamento', () => {
  test('CLI-PAD-05 — pacote íntegro: saída 0, nenhuma consulta e nenhuma operação de armazenamento, o relatório diz 90 arquivos conferidos e 30 imagens, e não vaza caminho', async () => {
    const c = caso(ZIP_INTEGRO);
    const t = verificarComando(c);
    const r = await t.chamada;
    assert.equal(r.saida, 0);
    assert.deepEqual([t.sql, t.armazenamento], [[], []]);
    const texto = t.capturada.texto();
    assert.match(texto, /\b90\b/);
    assert.match(texto, /\b30\b/);
    assert.ok(texto.includes(NOME_ZIP), 'o nome do pacote (sem a pasta) pode aparecer');
    limpa(texto, c);
    assert.deepEqual(fs.readdirSync(c.pasta), [NOME_ZIP], 'nada foi criado ao lado do ZIP');
  });

  const FALHAS = [
    ['PNG padronizado trocado por outro válido', () => h.zipDoPacote(pacote, ADULTERACOES[0][1]), 'PACOTE_HASH_DIVERGENTE'],
    ['miniatura com um byte invertido', () => h.zipDoPacote(pacote, ADULTERACOES[3][1]), 'PACOTE_HASH_DIVERGENTE'],
    ['hash do manifesto alterado', () => h.zipDoPacote(pacote, ADULTERACOES[5][1]), 'PACOTE_HASH_DIVERGENTE'],
    ['arquivo ausente do ZIP', () => h.zipDoPacote(pacote, { remover: [item.entradaMiniatura] }), 'PACOTE_ARQUIVO_AUSENTE'],
    ['manifesto com 29 linhas', () => h.zipDoPacote(pacote, { manifesto: MANIFESTOS_INVALIDOS[1][1] }), 'PACOTE_MANIFESTO_INVALIDO'],
    ['caminho perigoso (..)', () => HOSTIS.find((x) => x.descricao === 'dois pontos no início').construir(), 'PACOTE_INVALIDO'],
    ['link simbólico', () => HOSTIS.find((x) => x.descricao === 'link simbólico').construir(), 'PACOTE_INVALIDO'],
    ['ZIP corrompido', () => HOSTIS.find((x) => x.descricao === 'arquivo que não é um ZIP').construir(), 'PACOTE_INVALIDO'],
    ['PNG com metadados', () => h.zipDoPacote(h.pacoteComItem(pacote, 9, FORMATOS[0][1])), 'IMAGEM_PADRAO_INVALIDA'],
  ];
  FALHAS.forEach(([descricao, construir, codigo], k) => {
    test(`CLI-PAD-06.${String(k + 1).padStart(2, '0')} — ${descricao}: saída 3 (INTEGRIDADE), o código ${codigo} na saída, nada tocado, sem caminho nem segredo`, async () => {
      const c = caso(construir());
      const t = verificarComando(c);
      const r = await t.chamada;
      assert.equal(r.saida, 3);
      assert.deepEqual([t.sql, t.armazenamento], [[], []]);
      assert.ok(t.capturada.texto().includes(codigo), t.capturada.texto());
      limpa(t.capturada.texto(), c);
    });
  });

  test('CLI-PAD-07 — hash aprovado do ZIP que não confere (adulteração coordenada) e ZIP inexistente: saída 3, o código na saída, nada tocado', async () => {
    const c = caso(h.zipDoPacote(h.pacoteComItem(pacote, 9, { padronizado: h.pngFicticio({ semente: 'troca' }) })));
    const contraAprovado = { ...c, sha: h.sha256(ZIP_INTEGRO) };
    const t = verificarComando(contraAprovado);
    assert.equal((await t.chamada).saida, 3);
    assert.ok(t.capturada.texto().includes('PACOTE_SHA256_DIVERGENTE'));
    limpa(t.capturada.texto(), c);
    const ausente = verificarComando({ ...c, zip: path.join(c.pasta, 'nao-existe.zip') });
    assert.equal((await ausente.chamada).saida, 3);
    assert.ok(ausente.capturada.texto().includes('PACOTE_INDISPONIVEL'));
    assert.deepEqual([t.sql, t.armazenamento, ausente.sql, ausente.armazenamento], [[], [], [], []]);
  });

  test('CLI-PAD-08 — argumentos que o serviço recusa (caminho relativo que passou por engano): saída 2 (ARGUMENTOS), nada tocado', async () => {
    const c = caso(ZIP_INTEGRO);
    const t = verificarComando({ ...c, zip: 'relativo/pacote.zip' });
    assert.equal((await t.chamada).saida, 2);
    assert.deepEqual([t.sql, t.armazenamento], [[], []]);
    assert.ok(t.capturada.texto().includes('PACOTE_ARGUMENTOS_INVALIDOS'));
  });

  test('CLI-PAD-09 — nome de entrada hostil (sequência de terminal, CR, NUL, quebra de linha) nunca chega à saída como caractere de controle', async () => {
    const hostis = [
      { nome: '02_PNG_PADRONIZADOS/\u001b[31mvermelho\u001b[0m.png', dados: Buffer.from('x') },
      { nome: '02_PNG_PADRONIZADOS/linha\rsobrescrita.png', dados: Buffer.from('x') },
      { nome: Buffer.concat([Buffer.from('02_PNG_PADRONIZADOS/nulo'), Buffer.from([0]), Buffer.from('.png')]), dados: Buffer.from('x') },
      { nome: '02_PNG_PADRONIZADOS/quebra\nfalsa: tudo certo.png', dados: Buffer.from('x') },
      { nome: '02_PNG_PADRONIZADOS/‮bidi.png', dados: Buffer.from('x') },
    ];
    for (const entrada of hostis) {
      const c = caso(h.zipDoPacote(pacote, { adicionar: [entrada] }));
      const t = verificarComando(c);
      const r = await t.chamada;
      assert.equal(r.saida, 3);
      limpa(t.capturada.texto(), c);
      assert.doesNotMatch(t.capturada.texto(), /‮/, 'o controle bidirecional também não passa');
      assert.doesNotMatch(t.capturada.texto(), /^falsa:/m, 'o texto escondido no nome não vira uma linha da saída');
    }
  });
});

describe('[CLI-PAD] processo real (node scripts/imagens-importar-padrao.js)', () => {
  /** Processo de verdade, ambiente mínimo e banco INALCANÇÁVEL (porta 1): qualquer tentativa de conexão derruba o processo com saída 1. */
  function rodar(c, argumentos) {
    const cwd = fs.mkdtempSync(path.join(c.dir, 'cwd-'));
    const r = spawnSync(process.execPath, [SCRIPT, ...argumentos], {
      cwd,
      env: { PATH: process.env.PATH, NODE_ENV: 'test', DB_HOST: '127.0.0.1', DB_PORT: '1', DB_NAME: 'banco_inexistente', DB_USER: 'usuario_inexistente', DB_PASSWORD: SEGREDO },
      encoding: 'utf8',
      timeout: 120000,
    });
    return { status: r.status, saida: `${r.stdout}\n${r.stderr}`, cwd };
  }

  test('CLI-PAD-10 — --verificar de um pacote íntegro: saída 0 sem nenhum banco disponível, 90 arquivos conferidos, nada criado na pasta do ZIP nem na pasta de execução, sem segredo', () => {
    CLI();
    const c = caso(ZIP_INTEGRO);
    const r = rodar(c, ['--pacote', c.zip, '--sha256', c.sha, '--verificar']);
    assert.equal(r.status, 0, r.saida);
    assert.match(r.saida, /\b90\b/);
    limpa(r.saida, c);
    assert.deepEqual(fs.readdirSync(c.pasta), [NOME_ZIP]);
    assert.deepEqual(fs.readdirSync(r.cwd), [], 'nada foi criado na pasta de execução');
  });

  test('CLI-PAD-11 — --verificar de pacote adulterado: saída 3 e o código na saída; argumentos inválidos: saída 2 e o uso na saída; sem segredo em nenhum dos dois', () => {
    CLI();
    const adulterado = caso(h.zipDoPacote(pacote, ADULTERACOES[1][1]));
    const a = rodar(adulterado, ['--pacote', adulterado.zip, '--sha256', adulterado.sha, '--verificar']);
    assert.equal(a.status, 3, a.saida);
    assert.ok(a.saida.includes('PACOTE_HASH_DIVERGENTE'));
    limpa(a.saida, adulterado);

    const c = caso(ZIP_INTEGRO);
    const b = rodar(c, ['--pacote', 'relativo.zip', '--sha256', c.sha, '--verificar']);
    assert.equal(b.status, 2, b.saida);
    assert.ok(b.saida.includes('--pacote') && b.saida.includes('--executar'), 'o uso é impresso');
    limpa(b.saida, c);
    assert.equal(b.saida.includes('relativo.zip'), false);
  });

  test('CLI-PAD-12 — o modo padrão (sem --executar) não grava: com o banco inalcançável o processo falha (saída 1) em vez de seguir adiante, e nunca apresenta sucesso', () => {
    CLI();
    const c = caso(ZIP_INTEGRO);
    const r = rodar(c, ['--pacote', c.zip, '--sha256', c.sha]);
    assert.equal(r.status, 1, r.saida);
    limpa(r.saida, c);
    assert.doesNotMatch(r.saida, /sucesso|conclu[ií]d/i);
    assert.deepEqual(fs.readdirSync(c.pasta), [NOME_ZIP]);
  });
});
