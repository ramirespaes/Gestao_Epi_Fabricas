'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { criarArmazenamentoImagens, chaveDe } = require('../../src/storage/armazenamento-imagens');
const { inspecionarContainer, ErroDeImagem, CODIGOS } = require('../../src/utils/imagem-container');
const { pngFicticio } = require('../helpers/imagens-ficticias');
const { webpMinimo } = require('../helpers/imagens-validas');
const cli = require('../../scripts/imagens-completar-exibicao');

/**
 * IMG-EXIB-01 — scripts/imagens-completar-exibicao.js: completa a variante de EXIBIÇÃO (WebP 640x640) de UMA imagem padrão que ainda não a tem.
 * Tudo aqui é isolado: o banco é um dublê em memória (com trava por linha, COMMIT/ROLLBACK e as consultas exatas do script), o armazenamento é o REAL da
 * Biblioteca (publicação por link, sem sobrescrita) em diretório temporário, e o processador é um dublê que devolve a exibição escolhida pelo teste.
 * Nenhum teste toca o banco da cópia, o armazenamento da cópia, o sharp ou uma fotografia real; nenhum precisa de PostgreSQL.
 */

const BANCO = 'gestao_teste';
const OID = '4242';
const H1 = 'a'.repeat(64);
const H2 = 'b'.repeat(64);
const LADO = 640;

const sha256Hex = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const le32 = (n) => { const b = Buffer.alloc(4); b.writeUInt32LE(n); return b; };
const pedaco = (tipo, dados) => Buffer.concat([Buffer.from(tipo, 'ascii'), le32(dados.length), dados, Buffer.alloc(dados.length & 1)]);

/** WebP bem formado (RIFF + VP8L) cujo cabeçalho declara `lado` x `lado`; opcionalmente com bloco de metadados ou bytes depois do fim. */
function webp(lado, semente, { extra = 64, exif = false, depois = 0 } = {}) {
  const cab = Buffer.alloc(5);
  cab[0] = 0x2f;
  cab.writeUInt32LE((lado - 1) | ((lado - 1) << 14), 1);
  const enchimento = Buffer.from(sha256Hex(`corpo-${semente}`).repeat(Math.ceil(extra / 64)).slice(0, extra), 'latin1');
  const pedacos = [pedaco('VP8L', Buffer.concat([cab, enchimento]))];
  if (exif) pedacos.push(pedaco('EXIF', Buffer.from('metadados')));
  const corpo = Buffer.concat([Buffer.from('WEBP', 'ascii'), ...pedacos]);
  return Buffer.concat([Buffer.from('RIFF', 'ascii'), le32(corpo.length), corpo, Buffer.alloc(depois, 0x41)]);
}

const temporarios = [];
function novoTemporario() {
  const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'epi-exibicao-'));
  temporarios.push(diretorio);
  return diretorio;
}
after(() => {
  for (const diretorio of temporarios) {
    if (path.dirname(diretorio) === os.tmpdir() && path.basename(diretorio).startsWith('epi-exibicao-')) fs.rmSync(diretorio, { recursive: true, force: true });
  }
});

// ───────────────────────── dublê do banco ─────────────────────────
const AJUSTE_FUSO = "SET LOCAL TIME ZONE 'UTC'";
const AJUSTE_ESTILO = "SET LOCAL DateStyle TO 'ISO, YMD'";
const AJUSTES_PERMITIDOS = new Set(["SET LOCAL lock_timeout = '5s'", AJUSTE_FUSO, AJUSTE_ESTILO]);
const impressaoDe = (estado) => ['imagens_empresa', 'imagens_padrao', 'imagens_padrao_tipos', 'materiais_imagem'].map((t) => ({
  t, n: String(t === 'imagens_padrao' ? estado.linhas.size : 0), h: sha256Hex(JSON.stringify(t === 'imagens_padrao' ? [...estado.linhas] : [])).slice(0, 32),
}));

function criarBanco({ banco = BANCO, oid = OID, linhas = [] } = {}) {
  const estado = {
    banco, oid, linhas: new Map(linhas.map((l) => [String(l.id), { ...l }])), sql: [], conexoes: 0, travas: new Map(), transacoes: [],
    falhas: { update: false, commit: null, travaOcupada: false, leituraFresca: false }, aoAtualizar: null,
  };
  estado.impressao = () => impressaoDe(estado);
  const ler = (id) => { const l = estado.linhas.get(String(id)); return l === undefined ? null : { ...l, id: String(l.id) }; };
  function adquirir(id) {
    const chave = String(id);
    const anterior = estado.travas.get(chave) ?? Promise.resolve();
    let liberar;
    const minha = new Promise((resolver) => { liberar = resolver; });
    estado.travas.set(chave, anterior.then(() => minha));
    return anterior.then(() => ({ liberar }));
  }
  function cliente() {
    let pendente = null;
    let trava = null;
    let tx = null;
    const soltar = () => { if (trava !== null) { trava.liberar(); trava = null; } };
    return {
      async query(texto, params = []) {
        estado.sql.push(texto);
        if (texto === 'BEGIN' || texto === 'BEGIN READ ONLY') { tx = { texto, ajustes: [] }; estado.transacoes.push(tx); return { rows: [], rowCount: 0 }; }
        if (AJUSTES_PERMITIDOS.has(texto)) {
          if (tx === null) throw new Error('SET LOCAL fora de uma transação');
          tx.ajustes.push(texto);
          return { rows: [], rowCount: 0 };
        }
        if (/^SET\b/i.test(texto)) throw new Error(`SET desconhecido: ${texto}`);
        if (texto === 'ROLLBACK') { pendente = null; tx = null; soltar(); return { rows: [], rowCount: 0 }; }
        if (texto === 'COMMIT') {
          const modo = estado.falhas.commit;
          if (pendente !== null && modo !== 'perdido') Object.assign(estado.linhas.get(pendente.id), pendente.campos);
          pendente = null;
          tx = null;
          soltar();
          if (modo !== null) throw new Error('falha de COMMIT simulada');
          return { rows: [], rowCount: 0 };
        }
        if (texto.startsWith('SELECT current_database()')) return { rows: [{ banco: estado.banco, oid: estado.oid }], rowCount: 1 };
        if (texto.startsWith('SELECT json_agg(r ORDER BY r.t)')) {
          if (tx === null || !tx.ajustes.includes(AJUSTE_FUSO) || !tx.ajustes.includes(AJUSTE_ESTILO)) throw new Error('impressão digital sem fuso e estilo fixados na transação');
          return { rows: [{ v: JSON.stringify(impressaoDe(estado)) }], rowCount: 1 };
        }
        if (texto.startsWith('SELECT id::text')) {
          if (texto.endsWith('FOR UPDATE')) {
            if (estado.falhas.travaOcupada) throw Object.assign(new Error('lock_timeout'), { code: '55P03' });
            trava = await adquirir(params[0]);
          }
          const linha = ler(params[0]);
          return { rows: linha === null ? [] : [linha], rowCount: linha === null ? 0 : 1 };
        }
        if (texto.startsWith('UPDATE imagens_padrao')) {
          if (estado.falhas.update) throw new Error('falha de UPDATE simulada');
          if (estado.aoAtualizar !== null) estado.aoAtualizar(estado);
          const [id, sha, bytes, shaMestre] = params;
          const linha = estado.linhas.get(String(id));
          if (!linha || linha.sha256 !== shaMestre || linha.sha256_exibicao !== null || linha.bytes_exibicao !== null) return { rows: [], rowCount: 0 };
          pendente = { id: String(id), campos: { sha256_exibicao: sha, bytes_exibicao: bytes } };
          return { rows: [], rowCount: 1 };
        }
        throw new Error(`SQL inesperado: ${texto}`);
      },
      release() { soltar(); },
    };
  }
  const pool = {
    connect: async () => { estado.conexoes += 1; return cliente(); },
    query: async (texto, params = []) => {
      estado.sql.push(texto);
      if (texto.startsWith('SELECT sha256_exibicao')) {
        if (estado.falhas.leituraFresca) throw new Error('leitura simulada falhou');
        const linha = ler(params[0]);
        return { rows: linha === null ? [] : [{ sha256_exibicao: linha.sha256_exibicao }], rowCount: 1 };
      }
      throw new Error(`SQL inesperado no pool: ${texto}`);
    },
  };
  return { ...estado, estado, pool };
}

// ───────────────────────── dublê do processador e da saída ─────────────────────────
function processadorFalso({ exibicao = webp(LADO, 'exibicao'), segunda = null, falha = null } = {}) {
  const chamadas = [];
  return {
    chamadas,
    processar: async (bytes) => {
      chamadas.push(bytes);
      if (falha !== null) throw falha;
      const saida = chamadas.length === 2 && segunda !== null ? segunda : exibicao;
      return { formato: 'PNG', largura: 1024, altura: 1024, mestre: Buffer.from('MESTRE-DO-PROCESSADOR'), exibicao: saida, miniatura: Buffer.from('MINIATURA-DO-PROCESSADOR') };
    },
    encerrarTodos: async () => {},
  };
}
const coletor = () => { const linhas = []; return { linhas, log: (m) => linhas.push(String(m)), error: (m) => linhas.push(String(m)) }; };

// ───────────────────────── fixtures de armazenamento ─────────────────────────
async function semear(real, { id, formato = 'PNG', extraMestre = 120 }) {
  const mestre = pngFicticio(`mestre-${id}`, extraMestre);
  const miniatura = webpMinimo(`mini-${id}`, 80);
  const sha = sha256Hex(mestre);
  await real.gravar(chaveDe({ escopo: 'PADRAO', sha256: sha, variante: 'mestre', formato }), mestre, { maxBytes: 1 << 20 });
  await real.gravar(chaveDe({ escopo: 'PADRAO', sha256: sha, variante: 'miniatura', formato: 'WEBP' }), miniatura, { maxBytes: 1 << 20 });
  return {
    mestre, miniatura,
    linha: { id, sha256: sha, sha256_miniatura: sha256Hex(miniatura), sha256_exibicao: null, formato, bytes_mestre: mestre.length, bytes_miniatura: miniatura.length, bytes_exibicao: null },
  };
}

async function montar({ ids = ['22'], ajustar = null } = {}) {
  const dir = novoTemporario();
  const real = criarArmazenamentoImagens({ diretorio: dir });
  const imagens = {};
  for (const id of ids) imagens[id] = await semear(real, { id });
  const linhas = ids.map((id) => imagens[id].linha);
  if (ajustar !== null) ajustar(linhas, imagens);
  return { dir, real, imagens, db: criarBanco({ linhas }) };
}

const caminhoDe = (ctx, id, nome) => path.join(ctx.dir, 'padrao', ctx.imagens[id].linha.sha256, nome);
const chaveExibicao = (ctx, id) => chaveDe({ escopo: 'PADRAO', sha256: ctx.imagens[id].linha.sha256, variante: 'exibicao', formato: 'WEBP' });

function inventario(dir) {
  const itens = [];
  const andar = (atual) => {
    for (const entrada of fs.readdirSync(atual, { withFileTypes: true })) {
      const completo = path.join(atual, entrada.name);
      if (entrada.isDirectory()) { andar(completo); continue; }
      const info = fs.statSync(completo);
      itens.push(`${path.relative(dir, completo)}|${info.size}|${info.ino}|${info.mtimeMs}|${sha256Hex(fs.readFileSync(completo))}`);
    }
  };
  andar(dir);
  return itens.sort();
}
const linhasDoBanco = (ctx) => JSON.stringify([...ctx.db.estado.linhas]);
const contar = (ctx, padrao) => ctx.db.estado.sql.filter((s) => padrao.test(s)).length;

function listarInventario(dir) {
  const itens = [];
  const andar = (atual) => {
    for (const entrada of fs.readdirSync(atual, { withFileTypes: true })) {
      const completo = path.join(atual, entrada.name);
      if (entrada.isDirectory()) andar(completo);
      else if (entrada.name !== 'exibicao.webp') itens.push(`${path.relative(dir, completo)}|${fs.statSync(completo).size}|${sha256Hex(fs.readFileSync(completo))}`);
    }
  };
  andar(path.join(dir, 'padrao'));
  return itens.sort();
}

function criarArtefatos(ctx) {
  const raiz = novoTemporario();
  const dump = path.join(raiz, 'copia.dump');
  fs.writeFileSync(dump, Buffer.concat([Buffer.from('PGDMP'), Buffer.alloc(64, 7)]), { mode: 0o600 });
  const inventarioArquivo = path.join(raiz, 'inventario.txt');
  fs.writeFileSync(inventarioArquivo, `${listarInventario(ctx.dir).join('\n')}\n`, { mode: 0o600 });
  const prova = path.join(raiz, 'prova.json');
  fs.writeFileSync(prova, JSON.stringify({ versao: 1, dumpSha256: sha256Hex(fs.readFileSync(dump)), impressao: ctx.db.estado.impressao(), restauradoEm: new Date().toISOString() }), { mode: 0o600 });
  return {
    raiz,
    artefatos: {
      backup: { arquivo: dump, sha256: sha256Hex(fs.readFileSync(dump)) },
      inventario: { arquivo: inventarioArquivo, sha256: sha256Hex(fs.readFileSync(inventarioArquivo)) },
      prova: { arquivo: prova },
    },
  };
}

async function rodar(ctx, opcoes = {}) {
  const modo = opcoes.modo ?? 'SIMULAR';
  const saida = coletor();
  const processador = opcoes.processador ?? processadorFalso();
  const armazenamento = opcoes.armazenamento ?? cli.criarArmazenamento(modo, ctx.dir);
  const artefatos = Object.hasOwn(opcoes, 'artefatos') ? opcoes.artefatos : (modo === 'EXECUTAR' ? criarArtefatos(ctx).artefatos : null);
  const resultado = await cli.executarComando({
    modo,
    id: opcoes.id ?? '22',
    destino: opcoes.destino ?? { banco: BANCO, oid: OID },
    diretorio: opcoes.diretorio ?? ctx.dir,
    artefatos,
  }, { pool: ctx.db.pool, armazenamento, processador, diretorioEfetivo: opcoes.diretorioEfetivo ?? ctx.dir, saida, agora: opcoes.agora, raizRepositorio: opcoes.raizRepositorio });
  return { ...resultado, texto: saida.linhas.join('\n'), processador, armazenamento };
}
const executar = (ctx, opcoes = {}) => rodar(ctx, { ...opcoes, modo: 'EXECUTAR' });

// ───────────────────────── fixture de teste ─────────────────────────
describe('a fixture WebP de teste', () => {
  test('a exibição válida do teste é aceita pelo inspetor de contêiner como WebP 640x640 sem metadados', () => {
    const info = inspecionarContainer(webp(LADO, 'x'), { ladoMin: LADO, ladoMax: LADO, pixelsMax: LADO * LADO });
    assert.deepEqual([info.formato, info.largura, info.altura, info.bytesExtras], ['WEBP', LADO, LADO, 0]);
  });
});

// ───────────────────────── argumentos ─────────────────────────
describe('interpretarArgumentos', () => {
  const base = ['--id', '22', '--banco-autorizado', BANCO, '--banco-oid', OID, '--diretorio-autorizado', '/dados/imagens'];

  test('o padrão é a simulação; o destino e o diretório são obrigatórios', () => {
    const r = cli.interpretarArgumentos(base);
    assert.deepEqual([r.ok, r.modo, r.id, r.destino, r.diretorio, r.artefatos], [true, 'SIMULAR', '22', { banco: BANCO, oid: OID }, '/dados/imagens', null]);
    assert.equal(cli.interpretarArgumentos([...base, '--dry-run']).modo, 'SIMULAR');
    for (const [sem, nome] of [['--id', 'id'], ['--banco-autorizado', 'banco'], ['--banco-oid', 'oid'], ['--diretorio-autorizado', 'diretório']]) {
      const i = base.indexOf(sem);
      const reduzido = base.filter((_, k) => k !== i && k !== i + 1);
      assert.equal(cli.interpretarArgumentos(reduzido).ok, false, nome);
    }
  });

  test('--executar exige os cinco argumentos de artefatos; a simulação os aceita juntos', () => {
    const cinco = ['--backup-arquivo', '/op/copia.dump', '--backup-sha256', H1, '--inventario-arquivo', '/op/inv.txt', '--inventario-sha256', H2, '--prova-restauracao-arquivo', '/op/prova.json'];
    const ok = cli.interpretarArgumentos([...base, ...cinco, '--executar']);
    assert.deepEqual([ok.ok, ok.modo, ok.artefatos.backup.arquivo, ok.artefatos.inventario.sha256, ok.artefatos.prova.arquivo], [true, 'EXECUTAR', '/op/copia.dump', H2, '/op/prova.json']);
    assert.equal(cli.interpretarArgumentos([...base, ...cinco]).modo, 'SIMULAR');
    assert.equal(cli.interpretarArgumentos([...base, '--executar']).ok, false);
    assert.equal(cli.interpretarArgumentos([...base, ...cinco.slice(0, 8)]).ok, false);
    assert.equal(cli.interpretarArgumentos([...base, ...cinco.map((v) => (v === '/op/inv.txt' ? 'inv.txt' : v))]).ok, false);
    assert.equal(cli.interpretarArgumentos([...base, ...cinco.map((v) => (v === H1 ? 'curto' : v))]).ok, false);
  });

  test('valores inválidos, modos conflitantes, repetidos e argumentos desconhecidos são recusados sem ecoar o valor', () => {
    const casos = [
      [...base, '--dry-run', '--executar'], [...base, '--dry-run', '--dry-run'], [...base, '--id', '23'], [...base, '--todas'], [...base, '--lote', '3'],
      ['--id', '0', ...base.slice(2)], ['--id', '007', ...base.slice(2)], ['--id', '9223372036854775808', ...base.slice(2)], ['--id', 'abc', ...base.slice(2)],
      base.map((v) => (v === BANCO ? 'banco;DROP' : v)), base.map((v) => (v === OID ? '0' : v)), base.map((v) => (v === OID ? '4294967296' : v)),
      base.map((v) => (v === '/dados/imagens' ? 'relativo/dir' : v)), base.map((v) => (v === '/dados/imagens' ? '/dados/../imagens' : v)), base.map((v) => (v === '/dados/imagens' ? '/' : v)),
      ['--id'], ['--id', '--banco-oid'],
    ];
    for (const argv of casos) {
      const r = cli.interpretarArgumentos(argv);
      assert.equal(r.ok, false, argv.join(' '));
      for (const sensivel of ['banco;DROP', 'relativo/dir', 'abc']) assert.equal(r.erro.includes(sensivel), false);
    }
  });
});

// ───────────────────────── simulação ─────────────────────────
describe('simulação (--dry-run, o padrão)', () => {
  test('não grava nada: banco só em transação READ ONLY, nenhum UPDATE, COMMIT ou trava, armazenamento intocado, mas a exibição é gerada e validada', async () => {
    const ctx = await montar();
    const antes = inventario(ctx.dir);
    const linhasAntes = linhasDoBanco(ctx);
    const r = await rodar(ctx);
    assert.equal(r.saida, 0);
    assert.equal(r.resultado.estado, 'PENDENTE');
    assert.equal(r.resultado.bytes, webp(LADO, 'exibicao').length);
    assert.equal(r.resultado.sha256, sha256Hex(webp(LADO, 'exibicao')));
    assert.equal(r.resultado.deterministico, true);
    assert.equal(r.processador.chamadas.length, 2);
    assert.ok(contar(ctx, /^BEGIN READ ONLY$/) === 1);
    assert.equal(contar(ctx, /^(UPDATE|COMMIT|SET LOCAL)|FOR UPDATE$/), 0);
    assert.deepEqual(inventario(ctx.dir), antes);
    assert.equal(linhasDoBanco(ctx), linhasAntes);
    assert.match(r.texto, /Simulação: nada foi gravado/);
  });

  test('o armazenamento da simulação recusa gravar e remover, e não cria o diretório quando ele não existe', async () => {
    const ctx = await montar();
    const leitura = cli.criarArmazenamento('SIMULAR', ctx.dir);
    await assert.rejects(leitura.gravar(chaveExibicao(ctx, '22'), webp(LADO, 'x'), { maxBytes: 1 << 20 }), /somente leitura/);
    await assert.rejects(leitura.remover(chaveExibicao(ctx, '22')), /somente leitura/);
    assert.equal(fs.existsSync(caminhoDe(ctx, '22', 'exibicao.webp')), false);
    const ausente = path.join(novoTemporario(), 'nao-existe');
    await assert.rejects(cli.criarArmazenamento('EXECUTAR', ausente).existe(chaveExibicao(ctx, '22')), (e) => e.codigo === 'DIRETORIO_NAO_AUTORIZADO');
    assert.equal(fs.existsSync(ausente), false, 'um diretório inexistente nunca é criado');
    const ligacao = path.join(novoTemporario(), 'ligacao');
    fs.symlinkSync(ctx.dir, ligacao);
    await assert.rejects(cli.criarArmazenamento('EXECUTAR', ligacao).existe(chaveExibicao(ctx, '22')), (e) => e.codigo === 'DIRETORIO_NAO_AUTORIZADO');
  });

  test('a saída não leva caminho absoluto nem hash completo', async () => {
    const ctx = await montar();
    const r = await rodar(ctx);
    assert.equal(r.texto.includes(ctx.dir), false);
    assert.doesNotMatch(r.texto, /[0-9a-f]{64}/);
    const e = await executar(ctx);
    assert.equal(e.texto.includes(ctx.dir), false);
    assert.doesNotMatch(e.texto, /[0-9a-f]{64}/);
  });
});

// ───────────────────────── destino ─────────────────────────
describe('destino autorizado', () => {
  test('banco ou OID diferentes do autorizado: recusa antes de ler o registro e sem gerar nada', async () => {
    for (const destino of [{ banco: 'outro_banco', oid: OID }, { banco: BANCO, oid: '1' }]) {
      const ctx = await montar();
      const antes = inventario(ctx.dir);
      const r = await executar(ctx, { destino });
      assert.deepEqual([r.saida, r.codigo], [2, 'DESTINO_NAO_AUTORIZADO']);
      assert.equal(contar(ctx, /^SELECT id::text/), 0, 'o registro nem é lido');
      assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
      assert.equal(r.processador.chamadas.length, 0);
      assert.deepEqual(inventario(ctx.dir), antes);
      assert.match(r.texto, /Informe o destino com --banco-autorizado/);
    }
  });

  test('diretório efetivo diferente do autorizado: recusa sem sequer conectar ao banco', async () => {
    const ctx = await montar();
    const r = await executar(ctx, { diretorioEfetivo: path.join(os.tmpdir(), 'outro-diretorio') });
    assert.deepEqual([r.saida, r.codigo], [2, 'DIRETORIO_NAO_AUTORIZADO']);
    assert.equal(ctx.db.estado.conexoes, 0);
    assert.equal(r.processador.chamadas.length, 0);
  });

  test('--executar sem os artefatos prévios é recusado antes de qualquer conexão', async () => {
    const ctx = await montar();
    const r = await executar(ctx, { artefatos: null });
    assert.deepEqual([r.saida, r.codigo], [2, 'PRE_CONDICOES_AUSENTES']);
    assert.equal(ctx.db.estado.conexoes, 0);
  });

  test('a execução registra os artefatos conferidos, só com prefixos de hash', async () => {
    const ctx = await montar();
    const r = await executar(ctx);
    assert.match(r.texto, /Artefatos conferidos: backup sha256 [0-9a-f]{12}…, inventário sha256 [0-9a-f]{12}…, prova de restauração sha256 [0-9a-f]{12}…/);
  });
});

// ───────────────────────── registro ─────────────────────────
describe('estado do registro', () => {
  test('exibição já registrada: nada é alterado, gerado ou gravado (simulação e execução)', async () => {
    for (const modo of ['SIMULAR', 'EXECUTAR']) {
      const ctx = await montar({ ajustar: (linhas) => { linhas[0].sha256_exibicao = 'c'.repeat(64); linhas[0].bytes_exibicao = 500; } });
      const antes = inventario(ctx.dir);
      const linhasAntes = linhasDoBanco(ctx);
      const r = await rodar(ctx, { modo });
      assert.deepEqual([r.saida, r.resultado.estado, r.resultado.arquivoPresente], [0, 'JA_COMPLETA', false], modo);
      assert.equal(r.processador.chamadas.length, 0);
      assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
      assert.deepEqual(inventario(ctx.dir), antes);
      assert.equal(linhasDoBanco(ctx), linhasAntes);
    }
  });

  test('registro parcial (só o hash ou só o tamanho) é rejeitado sem corrigir nada', async () => {
    for (const parcial of [{ sha256_exibicao: 'c'.repeat(64) }, { bytes_exibicao: 500 }]) {
      const ctx = await montar({ ajustar: (linhas) => Object.assign(linhas[0], parcial) });
      const antes = inventario(ctx.dir);
      const r = await executar(ctx);
      assert.deepEqual([r.saida, r.codigo], [4, 'REGISTRO_PARCIAL']);
      assert.equal(r.processador.chamadas.length, 0);
      assert.deepEqual(inventario(ctx.dir), antes);
      assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
    }
  });

  test('registro fora do formato (hash inválido, formato desconhecido, tamanho zero) é recusado', async () => {
    for (const defeito of [{ sha256: 'xyz' }, { formato: 'GIF' }, { bytes_mestre: 0 }, { sha256_exibicao: 'nao-e-hash', bytes_exibicao: 5 }]) {
      const ctx = await montar({ ajustar: (linhas) => Object.assign(linhas[0], defeito) });
      const r = await executar(ctx);
      assert.deepEqual([r.saida, r.codigo], [4, 'REGISTRO_INVALIDO'], JSON.stringify(defeito));
      assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
    }
  });

  test('identificador inexistente: código 3 e nenhuma escrita', async () => {
    const ctx = await montar();
    const r = await executar(ctx, { id: '99' });
    assert.deepEqual([r.saida, r.codigo], [3, 'IMAGEM_NAO_ENCONTRADA']);
    assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
  });
});

// ───────────────────────── mestre e miniatura ─────────────────────────
describe('conferência do mestre e da miniatura registrados', () => {
  const casos = [
    ['mestre alterado (mesmo tamanho)', (ctx) => { const p = caminhoDe(ctx, '22', 'mestre.png'); const b = fs.readFileSync(p); b[b.length - 1] ^= 0xff; fs.writeFileSync(p, b); }, 'MESTRE_DIVERGENTE'],
    ['mestre truncado', (ctx) => fs.writeFileSync(caminhoDe(ctx, '22', 'mestre.png'), pngFicticio('outro', 30)), 'MESTRE_DIVERGENTE'],
    ['mestre ausente', (ctx) => fs.rmSync(caminhoDe(ctx, '22', 'mestre.png')), 'MESTRE_AUSENTE'],
    ['tamanho registrado do mestre diferente', (ctx) => { ctx.db.estado.linhas.get('22').bytes_mestre += 1; }, 'MESTRE_DIVERGENTE'],
    ['mestre maior que o limite de entrada', (ctx) => { ctx.db.estado.linhas.get('22').bytes_mestre = 3 * 1024 * 1024; }, 'MESTRE_GRANDE_DEMAIS'],
    ['miniatura alterada', (ctx) => { const p = caminhoDe(ctx, '22', 'miniatura.webp'); const b = fs.readFileSync(p); b[b.length - 1] ^= 0xff; fs.writeFileSync(p, b); }, 'MINIATURA_DIVERGENTE'],
    ['miniatura ausente', (ctx) => fs.rmSync(caminhoDe(ctx, '22', 'miniatura.webp')), 'MINIATURA_AUSENTE'],
    ['miniatura que não é WebP', (ctx) => { const falsa = pngFicticio('falsa', 80); fs.writeFileSync(caminhoDe(ctx, '22', 'miniatura.webp'), falsa); Object.assign(ctx.db.estado.linhas.get('22'), { sha256_miniatura: sha256Hex(falsa), bytes_miniatura: falsa.length }); }, 'MINIATURA_DIVERGENTE'],
  ];
  for (const [nome, manipular, esperado] of casos) {
    test(`${nome}: bloqueia (${esperado}) sem gerar nem gravar nada`, async () => {
      const ctx = await montar();
      manipular(ctx);
      const antes = inventario(ctx.dir);
      const linhasAntes = linhasDoBanco(ctx);
      const r = await executar(ctx);
      assert.deepEqual([r.saida, r.codigo], [4, esperado]);
      assert.equal(r.processador.chamadas.length, 0, 'nada é processado');
      assert.deepEqual(inventario(ctx.dir), antes);
      assert.equal(linhasDoBanco(ctx), linhasAntes);
      assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
      assert.ok(contar(ctx, /^ROLLBACK$/) >= 1);
    });
  }
});

// ───────────────────────── a variante gerada ─────────────────────────
describe('conformidade da exibição gerada', () => {
  const invalidas = [
    ['medidas erradas (320x320)', webp(320, 'pequena')], ['PNG em vez de WebP', pngFicticio('png', 200)], ['vazia', Buffer.alloc(0)],
    ['maior que o limite de 512 KiB', webp(LADO, 'grande', { extra: 600 * 1024 })], ['com bloco de metadados', webp(LADO, 'exif', { exif: true })],
    ['com bytes depois do fim', webp(LADO, 'cauda', { depois: 16 })], ['não é Buffer', { exibicao: 'texto' }], ['ausente', null],
  ];
  for (const [nome, exibicao] of invalidas) {
    test(`exibição inválida (${nome}) é recusada sem gravar nada`, async () => {
      const ctx = await montar();
      const antes = inventario(ctx.dir);
      const r = await executar(ctx, { processador: processadorFalso({ exibicao }) });
      assert.deepEqual([r.saida, r.codigo], [4, 'VARIANTE_GERADA_INVALIDA']);
      assert.deepEqual(inventario(ctx.dir), antes);
      assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
    });
  }

  test('falhas do processador: mestre recusado (4), sharp indisponível (1) e falha genérica (1), sempre sem gravar', async () => {
    const casos = [
      [new ErroDeImagem(CODIGOS.INVALIDA), 4, 'MESTRE_RECUSADO'],
      [Object.assign(new Error('x'), { codigo: 'IMAGENS_INDISPONIVEL' }), 1, 'PROCESSADOR_INDISPONIVEL'],
      [new Error('explodiu'), 1, 'PROCESSAMENTO_FALHOU'],
    ];
    for (const [falha, saida, codigo] of casos) {
      const ctx = await montar();
      const antes = inventario(ctx.dir);
      const r = await executar(ctx, { processador: processadorFalso({ falha }) });
      assert.deepEqual([r.saida, r.codigo], [saida, codigo]);
      assert.deepEqual(inventario(ctx.dir), antes);
    }
  });

  test('o determinismo é só informativo: saída diferente na segunda geração é relatada e não impede a correção', async () => {
    const ctx = await montar();
    const r = await executar(ctx, { processador: processadorFalso({ segunda: webp(LADO, 'diferente') }) });
    assert.equal(r.saida, 0);
    assert.equal(r.resultado.deterministico, false);
    assert.equal(r.resultado.estado, 'CORRIGIDA');
    assert.match(r.texto, /determinismo NÃO confirmado/);
  });

  test('a exibição publicada confere com o registro: hash, tamanho, WebP 640x640, modo 0600 e nenhum temporário', async () => {
    const ctx = await montar();
    const gerada = webp(LADO, 'exibicao');
    const r = await executar(ctx);
    assert.equal(r.saida, 0);
    const arquivo = caminhoDe(ctx, '22', 'exibicao.webp');
    const em_disco = fs.readFileSync(arquivo);
    const linha = ctx.db.estado.linhas.get('22');
    assert.deepEqual([linha.sha256_exibicao, linha.bytes_exibicao], [sha256Hex(gerada), gerada.length]);
    assert.deepEqual([sha256Hex(em_disco), em_disco.length], [linha.sha256_exibicao, linha.bytes_exibicao]);
    assert.equal(r.resultado.verificado, true);
    const info = inspecionarContainer(em_disco, { ladoMin: LADO, ladoMax: LADO, pixelsMax: LADO * LADO });
    assert.deepEqual([info.formato, info.largura, info.altura, info.bytesExtras], ['WEBP', LADO, LADO, 0]);
    assert.equal((fs.statSync(arquivo).mode & 0o777).toString(8), '600');
    assert.deepEqual(fs.readdirSync(path.dirname(arquivo)).filter((n) => n.endsWith('.tmp')), []);
  });
});

// ───────────────────────── execução, histórico e idempotência ─────────────────────────
describe('execução (--executar)', () => {
  test('grava a transação na ordem prevista: trava curta, trava da linha, UPDATE condicional dos dois campos, COMMIT', async () => {
    const ctx = await montar();
    const r = await executar(ctx);
    assert.deepEqual([r.saida, r.resultado.estado, r.resultado.publicadoAgora], [0, 'CORRIGIDA', true]);
    const sql = ctx.db.estado.sql;
    const indice = (re) => sql.findIndex((s) => re.test(s));
    assert.ok(indice(/^BEGIN$/) < indice(/^SET LOCAL lock_timeout = '5s'$/));
    assert.ok(indice(/^SET LOCAL/) < indice(/^SELECT current_database/));
    assert.ok(indice(/^SELECT current_database/) < indice(/FOR UPDATE$/));
    assert.ok(indice(/FOR UPDATE$/) < indice(/^UPDATE imagens_padrao/));
    assert.ok(indice(/^UPDATE imagens_padrao/) < indice(/^COMMIT$/));
    const update = sql.find((s) => /^UPDATE imagens_padrao/.test(s));
    assert.match(update, /SET sha256_exibicao = \$2, bytes_exibicao = \$3 WHERE id = \$1::bigint AND sha256 = \$4 AND sha256_exibicao IS NULL AND bytes_exibicao IS NULL$/);
    assert.equal(contar(ctx, /^UPDATE/), 1);
  });

  test('os arquivos históricos (mestre e miniatura) não mudam: mesmo conteúdo, inode e data; a única novidade é a exibição', async () => {
    const ctx = await montar();
    const antes = inventario(ctx.dir);
    const r = await executar(ctx);
    assert.equal(r.saida, 0);
    const depois = inventario(ctx.dir);
    const novos = depois.filter((i) => !antes.includes(i));
    assert.equal(novos.length, 1);
    assert.match(novos[0], /exibicao\.webp\|/);
    assert.deepEqual(antes.filter((i) => !depois.includes(i)), [], 'nada preexistente mudou ou sumiu');
    assert.notEqual(fs.readFileSync(caminhoDe(ctx, '22', 'mestre.png')).toString('latin1'), 'MESTRE-DO-PROCESSADOR', 'a saída de mestre do processador é descartada');
    assert.notEqual(fs.readFileSync(caminhoDe(ctx, '22', 'miniatura.webp')).toString('latin1'), 'MINIATURA-DO-PROCESSADOR');
  });

  test('idempotente: a segunda execução não processa, não grava e não altera nada', async () => {
    const ctx = await montar();
    const primeira = await executar(ctx);
    assert.equal(primeira.resultado.estado, 'CORRIGIDA');
    const inventarioDepois = inventario(ctx.dir);
    const linhasDepois = linhasDoBanco(ctx);
    const segunda = await executar(ctx);
    assert.deepEqual([segunda.saida, segunda.resultado.estado, segunda.resultado.arquivoPresente], [0, 'JA_COMPLETA', true]);
    assert.equal(segunda.processador.chamadas.length, 0);
    assert.deepEqual(inventario(ctx.dir), inventarioDepois);
    assert.equal(linhasDoBanco(ctx), linhasDepois);
    assert.equal(contar(ctx, /^UPDATE/), 1);
  });

  test('só a imagem pedida é corrigida: as outras linhas e os outros arquivos ficam como estavam', async () => {
    const ctx = await montar({ ids: ['1', '2', '3'] });
    const outras = ['1', '3'].map((id) => JSON.stringify(ctx.db.estado.linhas.get(id)));
    const arquivosAntes = inventario(ctx.dir);
    const r = await executar(ctx, { id: '2' });
    assert.equal(r.resultado.estado, 'CORRIGIDA');
    assert.deepEqual(['1', '3'].map((id) => JSON.stringify(ctx.db.estado.linhas.get(id))), outras);
    assert.notEqual(ctx.db.estado.linhas.get('2').sha256_exibicao, null);
    const novos = inventario(ctx.dir).filter((i) => !arquivosAntes.includes(i));
    assert.equal(novos.length, 1);
    assert.ok(novos[0].startsWith(path.join('padrao', ctx.imagens['2'].linha.sha256, 'exibicao.webp')));
  });
});

// ───────────────────────── nunca sobrescrever ─────────────────────────
describe('arquivo de exibição preexistente', () => {
  test('com conteúdo diferente: nunca é sobrescrito, nada muda no banco', async () => {
    const ctx = await montar();
    const outro = webp(LADO, 'outro-conteudo');
    await ctx.real.gravar(chaveExibicao(ctx, '22'), outro, { maxBytes: 1 << 20 });
    const antes = inventario(ctx.dir);
    const linhasAntes = linhasDoBanco(ctx);
    const r = await executar(ctx);
    assert.deepEqual([r.saida, r.codigo], [4, 'EXIBICAO_EXISTENTE_DIVERGENTE']);
    assert.deepEqual(fs.readFileSync(caminhoDe(ctx, '22', 'exibicao.webp')), outro);
    assert.deepEqual(inventario(ctx.dir), antes);
    assert.equal(linhasDoBanco(ctx), linhasAntes);
    assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
  });

  test('a simulação já acusa o conflito (conteúdo diferente) e a sobra igual, sem gravar nada', async () => {
    const ctx = await montar();
    await ctx.real.gravar(chaveExibicao(ctx, '22'), webp(LADO, 'outro-conteudo'), { maxBytes: 1 << 20 });
    const antes = inventario(ctx.dir);
    const conflito = await rodar(ctx);
    assert.deepEqual([conflito.saida, conflito.codigo], [4, 'EXIBICAO_EXISTENTE_DIVERGENTE']);
    assert.deepEqual(inventario(ctx.dir), antes);
    const ctx2 = await montar();
    await ctx2.real.gravar(chaveExibicao(ctx2, '22'), webp(LADO, 'exibicao'), { maxBytes: 1 << 20 });
    const sobra = await rodar(ctx2);
    assert.deepEqual([sobra.saida, sobra.resultado.estado, sobra.resultado.arquivoPreexistente], [0, 'PENDENTE', 'IGUAL']);
    assert.equal(contar(ctx2, /^UPDATE|^COMMIT/), 0);
  });

  test('com o armazenamento recusando por conteúdo diferente na hora de publicar (corrida): a recusa é a mesma e o original fica', async () => {
    const ctx = await montar();
    const real = cli.criarArmazenamento('EXECUTAR', ctx.dir);
    const armazenamento = { ...real, gravar: async () => { throw Object.assign(new Error('x'), { codigo: 'CHAVE_COM_CONTEUDO_DIFERENTE' }); } };
    const r = await executar(ctx, { armazenamento });
    assert.deepEqual([r.saida, r.codigo], [4, 'EXIBICAO_EXISTENTE_DIVERGENTE']);
    assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
  });

  test('com o MESMO conteúdo (sobra de uma execução interrompida): é reaproveitado sem regravar e o registro é completado', async () => {
    const ctx = await montar();
    const gerada = webp(LADO, 'exibicao');
    await ctx.real.gravar(chaveExibicao(ctx, '22'), gerada, { maxBytes: 1 << 20 });
    const infoAntes = fs.statSync(caminhoDe(ctx, '22', 'exibicao.webp'));
    const r = await executar(ctx);
    assert.deepEqual([r.saida, r.resultado.estado, r.resultado.publicadoAgora, r.resultado.arquivoPreexistente], [0, 'CORRIGIDA', false, 'IGUAL']);
    const infoDepois = fs.statSync(caminhoDe(ctx, '22', 'exibicao.webp'));
    assert.deepEqual([infoDepois.ino, infoDepois.mtimeMs], [infoAntes.ino, infoAntes.mtimeMs]);
    assert.equal(ctx.db.estado.linhas.get('22').sha256_exibicao, sha256Hex(gerada));
  });

  test('o arquivo preexistente igual NUNCA é removido, nem quando a atualização do banco falha', async () => {
    const ctx = await montar();
    await ctx.real.gravar(chaveExibicao(ctx, '22'), webp(LADO, 'exibicao'), { maxBytes: 1 << 20 });
    const antes = inventario(ctx.dir);
    ctx.db.estado.falhas.update = true;
    await assert.rejects(executar(ctx), /falha de UPDATE simulada/);
    assert.deepEqual(inventario(ctx.dir), antes);
    assert.equal(ctx.db.estado.linhas.get('22').sha256_exibicao, null);
  });
});

// ───────────────────────── falhas entre arquivo e banco ─────────────────────────
describe('falhas entre a publicação do arquivo e o COMMIT', () => {
  test('falha de publicação: o banco não é alterado, há ROLLBACK e nenhum arquivo de exibição', async () => {
    const ctx = await montar();
    const real = cli.criarArmazenamento('EXECUTAR', ctx.dir);
    const armazenamento = { ...real, gravar: async () => { throw Object.assign(new Error('x'), { codigo: 'ARMAZENAMENTO_FALHOU' }); } };
    const linhasAntes = linhasDoBanco(ctx);
    const r = await executar(ctx, { armazenamento });
    assert.deepEqual([r.saida, r.codigo], [1, 'PUBLICACAO_FALHOU']);
    assert.equal(linhasDoBanco(ctx), linhasAntes);
    assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
    assert.ok(contar(ctx, /^ROLLBACK$/) >= 1);
    assert.equal(fs.existsSync(caminhoDe(ctx, '22', 'exibicao.webp')), false);
  });

  test('falha do UPDATE: ROLLBACK, as outras linhas intactas e o arquivo criado por esta execução é removido', async () => {
    const ctx = await montar({ ids: ['22', '23', '24'] });
    const outras = ['23', '24'].map((id) => JSON.stringify(ctx.db.estado.linhas.get(id)));
    ctx.db.estado.falhas.update = true;
    const erro = await executar(ctx).then(() => null, (e) => e);
    assert.match(erro.message, /falha de UPDATE simulada/);
    assert.equal(erro.compensacao, 'REMOVIDO');
    assert.equal(fs.existsSync(caminhoDe(ctx, '22', 'exibicao.webp')), false);
    assert.equal(ctx.db.estado.linhas.get('22').sha256_exibicao, null);
    assert.deepEqual(['23', '24'].map((id) => JSON.stringify(ctx.db.estado.linhas.get(id))), outras);
    assert.ok(contar(ctx, /^ROLLBACK$/) >= 1);
    assert.equal(contar(ctx, /^COMMIT$/), 0);
  });

  test('alteração concorrente (nenhuma linha atualizada): interrompe, não toca em nada e mantém o arquivo se outro já o registrou', async () => {
    const ctx = await montar();
    ctx.db.estado.aoAtualizar = (estado) => Object.assign(estado.linhas.get('22'), { sha256_exibicao: 'e'.repeat(64), bytes_exibicao: 10 });
    const r = await executar(ctx);
    assert.deepEqual([r.saida, r.codigo], [4, 'ALTERACAO_CONCORRENTE']);
    assert.match(r.texto, /mantido \(já referenciado pelo registro\)/);
    assert.equal(ctx.db.estado.linhas.get('22').sha256_exibicao, 'e'.repeat(64), 'o valor do outro processo fica');
    assert.equal(contar(ctx, /^COMMIT$/), 0);
  });

  test('alteração concorrente sem registro de ninguém (o mestre foi trocado): o arquivo criado por esta execução é removido', async () => {
    const ctx = await montar();
    ctx.db.estado.aoAtualizar = (estado) => { estado.linhas.get('22').sha256 = 'f'.repeat(64); };
    const r = await executar(ctx);
    assert.deepEqual([r.saida, r.codigo], [4, 'ALTERACAO_CONCORRENTE']);
    assert.match(r.texto, /Arquivo criado por esta execução: removido/);
    assert.equal(fs.existsSync(caminhoDe(ctx, '22', 'exibicao.webp')), false);
  });

  test('COMMIT que falha sem gravar: o arquivo desta execução é removido e o banco continua sem exibição', async () => {
    const ctx = await montar();
    ctx.db.estado.falhas.commit = 'perdido';
    const erro = await executar(ctx).then(() => null, (e) => e);
    assert.match(erro.message, /falha de COMMIT simulada/);
    assert.equal(erro.compensacao, 'REMOVIDO');
    assert.equal(fs.existsSync(caminhoDe(ctx, '22', 'exibicao.webp')), false);
    assert.equal(ctx.db.estado.linhas.get('22').sha256_exibicao, null);
  });

  test('COMMIT que falha depois de gravar (resposta perdida): o registro é reconhecido, o arquivo fica e a verificação conclui', async () => {
    const ctx = await montar();
    ctx.db.estado.falhas.commit = 'aplicado';
    const r = await executar(ctx);
    assert.deepEqual([r.saida, r.resultado.estado, r.resultado.verificado], [0, 'CORRIGIDA', true]);
    assert.equal(fs.existsSync(caminhoDe(ctx, '22', 'exibicao.webp')), true);
  });

  test('COMMIT incerto (nem a releitura funciona): nada é removido e o código de saída manda investigar', async () => {
    const ctx = await montar();
    ctx.db.estado.falhas.commit = 'perdido';
    ctx.db.estado.falhas.leituraFresca = true;
    const r = await executar(ctx);
    assert.deepEqual([r.saida, r.codigo], [5, 'COMMIT_INCERTO']);
    assert.equal(fs.existsSync(caminhoDe(ctx, '22', 'exibicao.webp')), true, 'sem certeza do banco, o arquivo é preservado');
  });

  test('leitura de volta que não confere depois do COMMIT: o registro e o arquivo ficam e o código de saída manda investigar', async () => {
    const ctx = await montar();
    const real = cli.criarArmazenamento('EXECUTAR', ctx.dir);
    let publicado = false;
    const armazenamento = {
      ...real,
      gravar: async (...a) => { const r = await real.gravar(...a); publicado = true; return r; },
      abrir: async (chave) => (publicado && chave.endsWith('exibicao.webp') ? Readable.from([Buffer.from('corrompido')]) : real.abrir(chave)),
    };
    const r = await executar(ctx, { armazenamento });
    assert.deepEqual([r.saida, r.codigo], [5, 'VERIFICACAO_POSTERIOR_FALHOU']);
    assert.notEqual(ctx.db.estado.linhas.get('22').sha256_exibicao, null);
    assert.equal(fs.existsSync(caminhoDe(ctx, '22', 'exibicao.webp')), true);
  });
});

// ───────────────────────── concorrência ─────────────────────────
describe('concorrência', () => {
  test('registro bloqueado por outra operação (lock_timeout): recusa sem processar nem gravar', async () => {
    const ctx = await montar();
    ctx.db.estado.falhas.travaOcupada = true;
    const r = await executar(ctx);
    assert.deepEqual([r.saida, r.codigo], [4, 'REGISTRO_EM_USO']);
    assert.equal(r.processador.chamadas.length, 0);
    assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
    assert.equal(contar(ctx, /^SET LOCAL lock_timeout = '5s'$/), 1);
  });

  test('duas execuções ao mesmo tempo na mesma imagem: uma corrige e a outra encontra a exibição pronta; um único UPDATE e um único arquivo', async () => {
    const ctx = await montar();
    const [a, b] = await Promise.all([executar(ctx), executar(ctx)]);
    assert.deepEqual([a.saida, b.saida], [0, 0]);
    assert.deepEqual([a.resultado.estado, b.resultado.estado].sort(), ['CORRIGIDA', 'JA_COMPLETA']);
    assert.equal(contar(ctx, /^UPDATE/), 1);
    assert.equal(inventario(ctx.dir).filter((i) => i.includes('exibicao.webp')).length, 1);
    assert.equal(a.processador.chamadas.length + b.processador.chamadas.length, 2, 'só quem corrigiu processou (duas gerações para medir o determinismo)');
  });
});

// ───────────────────────── código-fonte ─────────────────────────
describe('contenção do código', () => {
  const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'imagens-completar-exibicao.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  test('a única escrita no banco é o UPDATE condicional da exibição; nenhum comando destrutivo ou de esquema', () => {
    assert.equal((fonte.match(/UPDATE\s+imagens_padrao/g) || []).length, 1);
    assert.doesNotMatch(fonte, /\b(INSERT|DELETE|TRUNCATE|DROP|ALTER|CREATE)\b\s+(INTO|FROM|TABLE|DATABASE|INDEX|SCHEMA)?/);
    assert.doesNotMatch(fonte, /rmSync|rmdirSync|unlinkSync|writeFileSync|renameSync|copyFileSync|execSync|spawnSync|child_process/);
  });

  test('só remove arquivo na compensação do que a própria execução criou, e não há modo em lote', () => {
    assert.equal((fonte.match(/armazenamento\.remover\(/g) || []).length, 1, 'a única remoção é a compensação do arquivo criado por esta execução');
    assert.doesNotMatch(fonte, /--todas|--lote|listar\(/);
    assert.doesNotMatch(fonte, /process\.env\.(DB_PASSWORD|[A-Z_]*SECRET|[A-Z_]*TOKEN)/);
  });
});

// ───────────────────────── A1: validação efetiva dos artefatos ─────────────────────────
describe('A1 — validação efetiva dos artefatos', () => {
  const HORA = 3600 * 1000;
  const tocar = (arquivo, segundos) => { const t = (Date.now() / 1000) + segundos; fs.utimesSync(arquivo, t, t); };
  const reescrever = (a, chave, arquivo, conteudo) => {
    fs.writeFileSync(arquivo, conteudo, { mode: 0o600 });
    if (a.artefatos[chave].sha256 !== undefined) a.artefatos[chave].sha256 = sha256Hex(fs.readFileSync(arquivo));
  };
  const lerProvaDe = (a) => JSON.parse(fs.readFileSync(a.artefatos.prova.arquivo, 'utf8'));
  const alterarProva = (fn) => (c, a) => { const p = lerProvaDe(a); fn(p); reescrever(a, 'prova', a.artefatos.prova.arquivo, JSON.stringify(p)); };
  const agoraMais = (ms) => new Date(Date.now() + ms).toISOString();

  const defeitosDeArquivo = [
    ['backup ausente', (c, a) => fs.rmSync(a.artefatos.backup.arquivo), 'ARTEFATO_INVALIDO'],
    ['backup é link simbólico', (c, a) => { const alvo = `${a.artefatos.backup.arquivo}.real`; fs.renameSync(a.artefatos.backup.arquivo, alvo); fs.symlinkSync(alvo, a.artefatos.backup.arquivo); }, 'ARTEFATO_INVALIDO', /backup: não é um arquivo comum/],
    ['backup com permissões abertas', (c, a) => fs.chmodSync(a.artefatos.backup.arquivo, 0o644), 'ARTEFATO_INVALIDO'],
    ['backup vazio', (c, a) => fs.truncateSync(a.artefatos.backup.arquivo, 0), 'ARTEFATO_INVALIDO'],
    ['backup alterado (hash informado não confere)', (c, a) => fs.appendFileSync(a.artefatos.backup.arquivo, 'x'), 'ARTEFATO_INVALIDO'],
    ['backup sem o cabeçalho PGDMP', (c, a) => reescrever(a, 'backup', a.artefatos.backup.arquivo, Buffer.alloc(80, 1)), 'ARTEFATO_INVALIDO', /backup: não é um dump no formato personalizado do PostgreSQL/],
    ['backup com mais de 2 h', (c, a) => tocar(a.artefatos.backup.arquivo, -3 * 3600), 'ARTEFATOS_EXPIRADOS'],
    ['inventário com mais de 2 h', (c, a) => tocar(a.artefatos.inventario.arquivo, -3 * 3600), 'ARTEFATOS_EXPIRADOS'],
    ['prova (arquivo) com mais de 2 h', (c, a) => tocar(a.artefatos.prova.arquivo, -3 * 3600), 'ARTEFATOS_EXPIRADOS'],
    ['backup com data de modificação no futuro', (c, a) => tocar(a.artefatos.backup.arquivo, 3600), 'ARTEFATO_INVALIDO'],
    ['backup dentro do diretório de imagens', (c, a) => {
      const dentro = path.join(c.dir, 'copia.dump');
      fs.copyFileSync(a.artefatos.backup.arquivo, dentro);
      fs.chmodSync(dentro, 0o600);
      a.artefatos.backup.arquivo = dentro;
    }, 'ARTEFATO_INVALIDO'],
    ['inventário com linha fora do formato', (c, a) => reescrever(a, 'inventario', a.artefatos.inventario.arquivo, 'lixo\n'), 'ARTEFATO_INVALIDO'],
    ['inventário com entrada repetida', (c, a) => {
      const primeira = fs.readFileSync(a.artefatos.inventario.arquivo, 'utf8').split('\n')[0];
      reescrever(a, 'inventario', a.artefatos.inventario.arquivo, `${primeira}\n${primeira}\n`);
    }, 'ARTEFATO_INVALIDO'],
    ['prova com JSON inválido', (c, a) => reescrever(a, 'prova', a.artefatos.prova.arquivo, '{'), 'ARTEFATO_INVALIDO'],
    ['prova com chave extra', alterarProva((p) => { p.extra = 1; }), 'ARTEFATO_INVALIDO'],
    ['prova de outro backup', alterarProva((p) => { p.dumpSha256 = 'e'.repeat(64); }), 'ARTEFATO_INVALIDO'],
    ['prova com impressão digital incompleta', alterarProva((p) => { p.impressao.pop(); }), 'ARTEFATO_INVALIDO'],
    ['recibo com restauradoEm de 3 h atrás (arquivo recém-modificado)', alterarProva((p) => { p.restauradoEm = agoraMais(-3 * HORA); }), 'ARTEFATOS_EXPIRADOS'],
    ['recibo com restauradoEm no futuro (arquivo recém-modificado)', alterarProva((p) => { p.restauradoEm = agoraMais(HORA); }), 'ARTEFATO_INVALIDO'],
    ['recibo com restauradoEm que não é data', alterarProva((p) => { p.restauradoEm = 'ontem'; }), 'ARTEFATO_INVALIDO'],
    ['recibo com restauradoEm sem hora e fuso', alterarProva((p) => { p.restauradoEm = '2026-10-21'; }), 'ARTEFATO_INVALIDO'],
  ];
  for (const [nome, manipular, esperado, motivo] of defeitosDeArquivo) {
    test(`${nome}: ${esperado}, antes de conectar ao banco e sem gerar nada`, async () => {
      const ctx = await montar();
      const a = criarArtefatos(ctx);
      manipular(ctx, a);
      const antes = inventario(ctx.dir);
      const r = await executar(ctx, { artefatos: a.artefatos });
      assert.deepEqual([r.saida, r.codigo], [4, esperado]);
      if (motivo !== undefined) assert.match(r.texto, motivo, 'a recusa tem de vir do motivo específico, não de outra validação');
      assert.equal(ctx.db.estado.conexoes, 0);
      assert.equal(r.processador.chamadas.length, 0);
      assert.deepEqual(inventario(ctx.dir), antes);
    });
  }

  test('artefatos dentro da raiz do repositório são recusados', async () => {
    const ctx = await montar();
    const a = criarArtefatos(ctx);
    const r = await executar(ctx, { artefatos: a.artefatos, raizRepositorio: a.raiz });
    assert.deepEqual([r.saida, r.codigo], [4, 'ARTEFATO_INVALIDO']);
    assert.equal(ctx.db.estado.conexoes, 0);
  });

  test('tolerância de relógio de 60 s: restauradoEm 30 s à frente passa; 2 min à frente não', async () => {
    const ctx = await montar();
    const ok = criarArtefatos(ctx);
    alterarProva((p) => { p.restauradoEm = agoraMais(30 * 1000); })(ctx, ok);
    assert.equal((await rodar(ctx, { modo: 'SIMULAR', artefatos: ok.artefatos })).resultado.estado, 'PENDENTE');
    const ruim = criarArtefatos(ctx);
    alterarProva((p) => { p.restauradoEm = agoraMais(120 * 1000); })(ctx, ruim);
    const r = await rodar(ctx, { modo: 'SIMULAR', artefatos: ruim.artefatos });
    assert.deepEqual([r.saida, r.codigo], [4, 'ARTEFATO_INVALIDO']);
  });

  const mexer = (c, id, nome, fn) => fn(path.join(c.dir, 'padrao', c.imagens[id].linha.sha256, nome));
  const trocarUmByte = (p) => { const b = fs.readFileSync(p); b[b.length - 1] ^= 0xff; fs.writeFileSync(p, b); };
  const defeitosContraODisco = [
    ['inventário com tamanho diferente do disco', (c, a) => {
      const linhas = fs.readFileSync(a.artefatos.inventario.arquivo, 'utf8').split('\n').filter(Boolean);
      const [caminho, bytes, hash] = linhas[0].split('|');
      linhas[0] = `${caminho}|${Number(bytes) + 1}|${hash}`;
      reescrever(a, 'inventario', a.artefatos.inventario.arquivo, `${linhas.join('\n')}\n`);
    }, 'ARTEFATOS_DESATUALIZADOS'],
    ['inventário com SHA-256 diferente do conteúdo (mesmo tamanho)', (c, a) => {
      const linhas = fs.readFileSync(a.artefatos.inventario.arquivo, 'utf8').split('\n').filter(Boolean)
        .map((l, i) => (i === 0 ? l.replace(/\|[0-9a-f]{64}$/, `|${'9'.repeat(64)}`) : l));
      reescrever(a, 'inventario', a.artefatos.inventario.arquivo, `${linhas.join('\n')}\n`);
    }, 'ARTEFATOS_DESATUALIZADOS'],
    ['arquivo de OUTRA imagem alterado preservando o tamanho', (c) => mexer(c, '23', 'miniatura.webp', trocarUmByte), 'ARTEFATOS_DESATUALIZADOS'],
    ['mestre da PRÓPRIA imagem alterado preservando o tamanho', (c) => mexer(c, '22', 'mestre.png', trocarUmByte), 'ARTEFATOS_DESATUALIZADOS'],
    ['arquivo novo no disco depois do inventário', (c) => {
      const pasta = path.join(c.dir, 'padrao', 'f'.repeat(64));
      fs.mkdirSync(pasta, { recursive: true });
      fs.writeFileSync(path.join(pasta, 'mestre.png'), 'novo');
    }, 'ARTEFATOS_DESATUALIZADOS'],
    ['arquivo do inventário ausente no disco', (c) => mexer(c, '22', 'miniatura.webp', (p) => fs.rmSync(p)), 'ARTEFATOS_DESATUALIZADOS'],
    ['arquivo substituído por link simbólico de mesmo conteúdo', (c) => mexer(c, '22', 'miniatura.webp', (p) => {
      const fora = path.join(novoTemporario(), 'miniatura.real');
      fs.writeFileSync(fora, fs.readFileSync(p));
      fs.rmSync(p);
      fs.symlinkSync(fora, p);
    }), 'ARTEFATOS_DESATUALIZADOS'],
    ['arquivo substituído por diretório', (c) => mexer(c, '22', 'miniatura.webp', (p) => { fs.rmSync(p); fs.mkdirSync(p); }), 'ARTEFATOS_DESATUALIZADOS'],
    ['arquivo com nome inesperado na pasta da imagem', (c) => mexer(c, '22', 'lixo.bin', (p) => fs.writeFileSync(p, 'x')), 'ARTEFATOS_DESATUALIZADOS'],
    ['exibicao.webp da própria imagem como link simbólico', (c) => mexer(c, '22', 'exibicao.webp', (p) => {
      const fora = path.join(novoTemporario(), 'exib.real');
      fs.writeFileSync(fora, webp(LADO, 'x'));
      fs.symlinkSync(fora, p);
    }), 'ARTEFATOS_DESATUALIZADOS'],
    ['exibicao.webp de OUTRA imagem presente', (c) => mexer(c, '23', 'exibicao.webp', (p) => fs.writeFileSync(p, webp(LADO, 'outra'))), 'ARTEFATOS_DESATUALIZADOS'],
    ['inventário com exibição que não existe no disco', (c, a) => {
      const texto = fs.readFileSync(a.artefatos.inventario.arquivo, 'utf8');
      reescrever(a, 'inventario', a.artefatos.inventario.arquivo, `${texto}padrao/${'c'.repeat(64)}/exibicao.webp|10|${'d'.repeat(64)}\n`);
    }, 'ARTEFATOS_DESATUALIZADOS'],
    ['dados relevantes mudaram depois da prova', (c) => { c.db.estado.linhas.set('999', { id: '999', sha256: 'a'.repeat(64) }); }, 'ARTEFATOS_DESATUALIZADOS'],
  ];
  for (const [nome, manipular, esperado] of defeitosContraODisco) {
    test(`${nome}: ${esperado}, com ROLLBACK, sem processar e sem escrever`, async () => {
      const ctx = await montar({ ids: ['22', '23'] });
      const a = criarArtefatos(ctx);
      manipular(ctx, a);
      const antes = inventario(ctx.dir);
      const r = await executar(ctx, { artefatos: a.artefatos });
      assert.deepEqual([r.saida, r.codigo], [4, esperado]);
      assert.equal(r.processador.chamadas.length, 0);
      assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
      assert.ok(contar(ctx, /^ROLLBACK$/) >= 1);
      assert.deepEqual(inventario(ctx.dir), antes);
    });
  }

  const linhaDeExibicao = (c, id) => {
    const b = fs.readFileSync(caminhoDe(c, id, 'exibicao.webp'));
    return `padrao/${c.imagens[id].linha.sha256}/exibicao.webp|${b.length}|${sha256Hex(b)}`;
  };
  const incluirNoInventario = (a, linha) => {
    reescrever(a, 'inventario', a.artefatos.inventario.arquivo, `${fs.readFileSync(a.artefatos.inventario.arquivo, 'utf8')}${linha}\n`);
  };

  test('exibição de OUTRA imagem presente no disco e no inventário é aceita, conferida e preservada, e a correção prossegue', async () => {
    const ctx = await montar({ ids: ['22', '23'] });
    await ctx.real.gravar(chaveExibicao(ctx, '23'), webp(LADO, 'outra-23'), { maxBytes: 1 << 20 });
    const a = criarArtefatos(ctx);
    incluirNoInventario(a, linhaDeExibicao(ctx, '23'));
    const antes = fs.statSync(caminhoDe(ctx, '23', 'exibicao.webp'));
    const r = await executar(ctx, { artefatos: a.artefatos });
    assert.deepEqual([r.saida, r.resultado.estado], [0, 'CORRIGIDA']);
    assert.deepEqual(fs.readFileSync(caminhoDe(ctx, '23', 'exibicao.webp')), webp(LADO, 'outra-23'));
    const depois = fs.statSync(caminhoDe(ctx, '23', 'exibicao.webp'));
    assert.deepEqual([depois.ino, depois.mtimeMs], [antes.ino, antes.mtimeMs]);
    assert.equal(ctx.db.estado.linhas.get('23').sha256_exibicao ?? null, null, 'a outra imagem não é tocada no banco');
  });

  test('exibição de OUTRA imagem alterada preservando o tamanho depois do inventário: ARTEFATOS_DESATUALIZADOS, sem processar nem escrever', async () => {
    const ctx = await montar({ ids: ['22', '23'] });
    await ctx.real.gravar(chaveExibicao(ctx, '23'), webp(LADO, 'outra-23'), { maxBytes: 1 << 20 });
    const a = criarArtefatos(ctx);
    incluirNoInventario(a, linhaDeExibicao(ctx, '23'));
    mexer(ctx, '23', 'exibicao.webp', trocarUmByte);
    const antes = inventario(ctx.dir);
    const r = await executar(ctx, { artefatos: a.artefatos });
    assert.deepEqual([r.saida, r.codigo], [4, 'ARTEFATOS_DESATUALIZADOS']);
    assert.equal(r.processador.chamadas.length, 0);
    assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
    assert.deepEqual(inventario(ctx.dir), antes);
  });

  test('inventário que lista a exibição da PRÓPRIA imagem alvo é recusado, sem processar e sem tocar no arquivo', async () => {
    const ctx = await montar({ ids: ['22', '23'] });
    await ctx.real.gravar(chaveExibicao(ctx, '22'), webp(LADO, 'exibicao'), { maxBytes: 1 << 20 });
    const a = criarArtefatos(ctx);
    incluirNoInventario(a, linhaDeExibicao(ctx, '22'));
    const antes = inventario(ctx.dir);
    const r = await executar(ctx, { artefatos: a.artefatos });
    assert.deepEqual([r.saida, r.codigo], [4, 'ARTEFATOS_DESATUALIZADOS']);
    assert.match(r.texto, /lista a exibição da imagem alvo/);
    assert.equal(r.processador.chamadas.length, 0);
    assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
    assert.deepEqual(inventario(ctx.dir), antes);
  });

  test('a imagem já completa não exige recibo atualizado: continua JA_COMPLETA', async () => {
    const ctx = await montar();
    const a = criarArtefatos(ctx);
    Object.assign(ctx.db.estado.linhas.get('22'), { sha256_exibicao: 'c'.repeat(64), bytes_exibicao: 500 });
    const r = await executar(ctx, { artefatos: a.artefatos });
    assert.deepEqual([r.saida, r.resultado.estado], [0, 'JA_COMPLETA']);
    assert.equal(contar(ctx, /^UPDATE|^COMMIT/), 0);
  });

  test('a simulação valida os artefatos informados (impressão incluída) e continua sem gravar', async () => {
    const ctx = await montar();
    const a = criarArtefatos(ctx);
    const antes = inventario(ctx.dir);
    const r = await rodar(ctx, { modo: 'SIMULAR', artefatos: a.artefatos });
    assert.deepEqual([r.saida, r.resultado.estado], [0, 'PENDENTE']);
    assert.equal(contar(ctx, /^SELECT json_agg\(r ORDER BY r\.t\)/), 1);
    assert.equal(contar(ctx, /^UPDATE|^COMMIT|FOR UPDATE$/), 0);
    assert.deepEqual(inventario(ctx.dir), antes);
    assert.match(r.texto, /Artefatos conferidos/);
  });

  test('os ajustes de fuso e estilo acontecem DENTRO da transação da leitura, antes da impressão', async () => {
    const ctx = await montar();
    const a = criarArtefatos(ctx);
    await rodar(ctx, { modo: 'SIMULAR', artefatos: a.artefatos });
    const t = ctx.db.estado.transacoes;
    assert.equal(t.length, 1);
    assert.equal(t[0].texto, 'BEGIN READ ONLY');
    assert.deepEqual(t[0].ajustes, ["SET LOCAL TIME ZONE 'UTC'", "SET LOCAL DateStyle TO 'ISO, YMD'"]);
    const sql = ctx.db.estado.sql;
    const i = (re) => sql.findIndex((s) => re.test(s));
    assert.ok(i(/^BEGIN READ ONLY$/) < i(/^SET LOCAL TIME ZONE/) && i(/^SET LOCAL TIME ZONE/) < i(/^SET LOCAL DateStyle/)
      && i(/^SET LOCAL DateStyle/) < i(/^SELECT json_agg/) && i(/^SELECT json_agg/) < i(/^ROLLBACK$/));
  });

  test('o dublê recusa SET LOCAL fora de transação, comandos SET desconhecidos e a impressão sem os ajustes', async () => {
    const db = criarBanco({ linhas: [] });
    const c = await db.pool.connect();
    await assert.rejects(c.query("SET LOCAL TIME ZONE 'UTC'"), /fora de uma transação/);
    await c.query('BEGIN READ ONLY');
    await assert.rejects(c.query(cli.SQL_IMPRESSAO), /sem fuso e estilo/);
    await assert.rejects(c.query('SET LOCAL work_mem = 1'), /SET desconhecido/);
    await assert.rejects(c.query('SET search_path TO public'), /SET desconhecido/);
    await c.query("SET LOCAL TIME ZONE 'UTC'");
    await c.query("SET LOCAL DateStyle TO 'ISO, YMD'");
    assert.deepEqual(JSON.parse((await c.query(cli.SQL_IMPRESSAO)).rows[0].v), db.estado.impressao());
    await c.query('ROLLBACK');
    c.release();
  });

  test('calcularImpressao: com pool abre transação somente-leitura própria; com cliente usa a transação existente', async () => {
    const ctx = await montar();
    assert.deepEqual(await cli.calcularImpressao(ctx.db.pool), ctx.db.estado.impressao());
    assert.equal(contar(ctx, /^BEGIN READ ONLY$/), 1);
    assert.equal(contar(ctx, /^ROLLBACK$/), 1);
    const cliente = await ctx.db.pool.connect();
    await cliente.query('BEGIN');
    assert.deepEqual(await cli.calcularImpressao(cliente), ctx.db.estado.impressao());
    assert.equal(contar(ctx, /^BEGIN READ ONLY$/), 1, 'sem transação nova quando já há cliente');
    await cliente.query('ROLLBACK');
    cliente.release();
  });

  test('o contrato da impressão digital (SQL_IMPRESSAO) é exatamente o aprovado', () => {
    const esperado = "SELECT json_agg(r ORDER BY r.t)::text AS v FROM ( SELECT 'imagens_padrao' AS t, count(*)::text AS n, md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) AS h FROM imagens_padrao x UNION ALL SELECT 'imagens_padrao_tipos', count(*)::text, md5(coalesce(string_agg(x::text, '|' ORDER BY x.imagem_padrao_id, x.tipo_nome), '')) FROM imagens_padrao_tipos x UNION ALL SELECT 'imagens_empresa', count(*)::text, md5(coalesce(string_agg(x::text, '|' ORDER BY x.id), '')) FROM imagens_empresa x UNION ALL SELECT 'materiais_imagem', count(*)::text, md5(coalesce(string_agg(m.id || ':' || coalesce(m.imagem_padrao_id::text, '-') || ':' || coalesce(m.imagem_empresa_id::text, '-') || ':' || m.ativo, '|' ORDER BY m.id), '')) FROM materiais m ) r";
    assert.equal(cli.SQL_IMPRESSAO.replace(/\s+/g, ' ').trim(), esperado);
  });

  test('a validação só lê: o código-fonte não ganha escrita nem remoção além da compensação, e não há modo de reversão', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', 'imagens-completar-exibicao.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.doesNotMatch(fonte, /writeFileSync|appendFileSync|renameSync|unlinkSync|rmSync|copyFileSync|mkdirSync|chmodSync|utimesSync|--reverter/);
    assert.equal((fonte.match(/armazenamento\.remover\(/g) || []).length, 1);
  });
});
