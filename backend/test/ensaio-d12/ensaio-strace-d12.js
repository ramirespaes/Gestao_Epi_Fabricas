'use strict';

/**
 * ENSAIO D-12 (sharp/libvips) — rastreamento das operações de arquivo do worker REAL de imagens, em Linux, com strace.
 * Uso: node test/ensaio-d12/ensaio-strace-d12.js --saida <diretório NOVO> [--sem-rastreador] [--autoteste]
 *   --sem-rastreador: só gera as entradas e roda o worker (ensaio de forma, para macOS); sem rastro, o veredito é NAO_RASTREADO.
 *   --autoteste: valida o analisador do rastro com linhas de exemplo e sai.
 * O que faz: gera imagens SINTÉTICAS (PNG, PNG entrelaçado, JPEG, WebP, inclusive no limite de pixels), passa cada uma pelo serviço real
 * (criarProcessadorDeImagens: área exclusiva, VIPS_DISC_THRESHOLD, limpeza) trocando apenas o início do filho por
 * `strace -f -e trace=file,process` (segue filhos e fios), mede o pico de memória da árvore do filho por /proc, e classifica cada
 * operação de arquivo do rastro: criação, escrita, remoção, renomeação, diretório — dentro ou fora da área exclusiva.
 * O que NÃO faz: não reduz o limiar do libvips nem força escrita (controle positivo proibido); não prova ausência universal de temporários.
 * Saídas: <saida>/entradas/*, <saida>/rastros/*.strace, <saida>/relatorio-ensaio-d12.json, <saida>/MANIFESTO-SHA256.txt. Códigos de saída:
 * 0 ensaio concluído (escritas observadas ficam no relatório, não no código), 1 erro do ensaio, 2 rastreador inoperante.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const BACKEND = path.resolve(__dirname, '..', '..');
const sharp = require(path.join(BACKEND, 'node_modules', 'sharp'));
const servico = require(path.join(BACKEND, 'src', 'services', 'imagem-processador.service.js'));

const STRACE = '/usr/bin/strace';
const CHAMADAS_DE_ESCRITA = new Set(['creat', 'mkdir', 'mkdirat', 'rename', 'renameat', 'renameat2', 'unlink', 'unlinkat', 'rmdir', 'symlink', 'symlinkat', 'link', 'linkat', 'truncate']);
const CHAMADAS_DE_ABERTURA = new Set(['open', 'openat', 'openat2']);
const RE_ESCRITA_FLAGS = /\bO_(?:WRONLY|RDWR|CREAT|TRUNC|TMPFILE|APPEND)\b/;
const RE_LINHA = /^(\d+)\s+(?:(\d+\.\d+)\s+)?(?:<\.\.\. (\w+) resumed>\s*(.*?)|(\w+)\((.*?))(?:\s*<unfinished \.\.\.>|\)\s*=\s*(-?\d+|\?)(.*))$/;

const sha256 = (b) => crypto.createHash('sha256').update(b).digest('hex');
const argumento = (nome) => { const i = process.argv.indexOf(nome); return i === -1 ? null : (process.argv[i + 1] ?? null); };
const temFlag = (nome) => process.argv.includes(nome);

/* ---------------------------------------------------------------- entradas sintéticas */

function gradiente(largura, altura) {
  const buf = Buffer.alloc(largura * altura * 3);
  for (let y = 0; y < altura; y += 1) {
    for (let x = 0; x < largura; x += 1) {
      const i = (y * largura + x) * 3;
      buf[i] = (x * 255 / largura) | 0; buf[i + 1] = (y * 255 / altura) | 0; buf[i + 2] = ((x + y) * 127 / (largura + altura)) | 0;
    }
  }
  return sharp(buf, { raw: { width: largura, height: altura, channels: 3 } });
}

/** Cenários: formatos aceitos, inclusive no teto de pixels (4096 x 2048 = pixelsMax) e PNG entrelaçado (caminho PARTIAL do libvips). */
const CENARIOS = [
  { nome: 'S1-png-pequena', largura: 400, altura: 400, codificar: (s) => s.png({ compressionLevel: 6 }), ext: 'png' },
  { nome: 'S2-jpeg-media', largura: 1600, altura: 1200, codificar: (s) => s.jpeg({ quality: 85 }), ext: 'jpeg' },
  { nome: 'S3-png-teto-de-pixels', largura: 4096, altura: 2048, codificar: (s) => s.png({ compressionLevel: 9 }), ext: 'png' },
  { nome: 'S4-png-entrelacado', largura: 2896, altura: 2896, codificar: (s) => s.png({ compressionLevel: 9, progressive: true }), ext: 'png' },
  { nome: 'S5-jpeg-teto-de-pixels', largura: 4096, altura: 2048, codificar: (s) => s.jpeg({ quality: 90 }), ext: 'jpeg' },
  { nome: 'S6-jpeg-progressivo', largura: 2896, altura: 2896, codificar: (s) => s.jpeg({ quality: 90, progressive: true }), ext: 'jpeg' },
  { nome: 'S7-webp-teto-de-pixels', largura: 4096, altura: 2048, codificar: (s) => s.webp({ quality: 80 }), ext: 'webp' },
  { nome: 'S8-webp-sem-perdas', largura: 2048, altura: 2048, codificar: (s) => s.webp({ lossless: true }), ext: 'webp' },
];

async function gerarEntradas(dir, entradaMaxBytes) {
  fs.mkdirSync(dir, { mode: 0o700 });
  const geradas = [];
  for (const c of CENARIOS) {
    const bytes = await c.codificar(gradiente(c.largura, c.altura)).toBuffer();
    const arquivo = path.join(dir, `${c.nome}.${c.ext}`);
    fs.writeFileSync(arquivo, bytes, { flag: 'wx', mode: 0o600 });
    geradas.push({ nome: c.nome, arquivo, largura: c.largura, altura: c.altura, formato: c.ext, bytes: bytes.length, sha256: sha256(bytes), dentroDoLimite: bytes.length <= entradaMaxBytes });
  }
  return geradas;
}

/* ---------------------------------------------------------------- memória por /proc (Linux) */

function descendentes(pidRaiz) {
  const filhos = new Map();
  let nomes;
  try { nomes = fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)); } catch { return []; }
  for (const n of nomes) {
    let status;
    try { status = fs.readFileSync(`/proc/${n}/status`, 'utf8'); } catch { continue; }
    const ppid = /^PPid:\s+(\d+)/m.exec(status);
    const hwm = /^VmHWM:\s+(\d+) kB/m.exec(status);
    const rss = /^VmRSS:\s+(\d+) kB/m.exec(status);
    if (!ppid) continue;
    const lista = filhos.get(Number(ppid[1])) ?? [];
    lista.push({ pid: Number(n), hwmKiB: hwm ? Number(hwm[1]) : 0, rssKiB: rss ? Number(rss[1]) : 0 });
    filhos.set(Number(ppid[1]), lista);
  }
  const saida = [];
  const fila = [pidRaiz];
  while (fila.length > 0) { const p = fila.shift(); for (const f of filhos.get(p) ?? []) { saida.push(f); fila.push(f.pid); } }
  return saida;
}

function monitorarMemoria(pidRaiz) {
  const amostra = { picoHwmKiB: 0, picoRssSomaKiB: 0, processosVistos: new Set(), amostras: 0 };
  if (process.platform !== 'linux') return { parar: () => ({ ...amostra, processosVistos: [], disponivel: false }) };
  const timer = setInterval(() => {
    const arvore = descendentes(pidRaiz);
    amostra.amostras += 1;
    let soma = 0;
    for (const p of arvore) { amostra.processosVistos.add(p.pid); amostra.picoHwmKiB = Math.max(amostra.picoHwmKiB, p.hwmKiB); soma += p.rssKiB; }
    amostra.picoRssSomaKiB = Math.max(amostra.picoRssSomaKiB, soma);
  }, 20);
  return { parar: () => { clearInterval(timer); return { ...amostra, processosVistos: [...amostra.processosVistos], disponivel: true }; } };
}

/* ---------------------------------------------------------------- análise do rastro */

function extrairCaminhos(args) {
  const caminhos = [];
  const re = /"((?:[^"\\]|\\.)*)"/g;
  for (let m = re.exec(args); m !== null; m = re.exec(args)) caminhos.push(m[1].replace(/\\x([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))));
  return caminhos;
}

const resolver = (caminho, cwd) => (path.isAbsolute(caminho) ? path.normalize(caminho) : path.normalize(path.join(cwd, caminho)));
const dentroDe = (caminho, raiz) => caminho === raiz || caminho.startsWith(`${raiz}${path.sep}`);

/** Reconstrói chamadas de um rastro `strace -f` (inclusive as partidas em <unfinished ...>/<... resumed>) e devolve só as de arquivo com efeito. */
function analisarRastro(texto, { area, cwd }) {
  const pendentes = new Map();
  const chamadas = [];
  let linhas = 0;
  for (const linha of texto.split('\n')) {
    if (linha.trim() === '') continue;
    linhas += 1;
    const m = RE_LINHA.exec(linha);
    if (!m) continue;
    const pid = Number(m[1]);
    let nome;
    let args;
    let resultado = m[7] ?? null;
    if (m[3]) { // "<... nome resumed> resto) = r"
      const inicio = pendentes.get(`${pid}:${m[3]}`);
      if (!inicio) continue;
      pendentes.delete(`${pid}:${m[3]}`);
      nome = m[3]; args = `${inicio}${m[4] ?? ''}`;
      const fim = /\)\s*=\s*(-?\d+|\?)/.exec(linha);
      resultado = fim ? fim[1] : null;
    } else {
      nome = m[5]; args = m[6] ?? '';
      if (/<unfinished \.\.\.>\s*$/.test(linha)) { pendentes.set(`${pid}:${nome}`, args); continue; }
    }
    if (!CHAMADAS_DE_ABERTURA.has(nome) && !CHAMADAS_DE_ESCRITA.has(nome)) continue;
    const caminhos = extrairCaminhos(args).map((c) => resolver(c, cwd));
    if (caminhos.length === 0) continue;
    const abertura = CHAMADAS_DE_ABERTURA.has(nome);
    const escrita = abertura ? RE_ESCRITA_FLAGS.test(args) : true;
    const falhou = resultado !== null && resultado !== '?' && Number(resultado) < 0;
    // Conservador: basta um caminho fora da área (ex.: destino de rename) para a operação contar como fora.
    chamadas.push({ pid, chamada: nome, caminhos, escrita, falhou, dentroDaArea: caminhos.every((c) => dentroDe(c, area)), args: args.slice(0, 300) });
  }
  const efeitos = chamadas.filter((c) => c.escrita && !c.falhou);
  const resumo = {
    linhasDoRastro: linhas, chamadasDeArquivo: chamadas.length, aberturasParaLeitura: chamadas.filter((c) => !c.escrita).length,
    escritasOuCriacoesDentroDaArea: efeitos.filter((c) => c.dentroDaArea).length, escritasOuCriacoesForaDaArea: efeitos.filter((c) => !c.dentroDaArea).length,
    tentativasDeEscritaFalhas: chamadas.filter((c) => c.escrita && c.falhou).length,
  };
  const prefixos = {};
  for (const c of chamadas.filter((x) => !x.escrita)) { for (const p of c.caminhos) { const chave = p.split('/').slice(0, 3).join('/') || '/'; prefixos[chave] = (prefixos[chave] ?? 0) + 1; } }
  return { resumo, efeitos: efeitos.map(({ pid, chamada, caminhos, dentroDaArea, args }) => ({ pid, chamada, caminhos, dentroDaArea, args })), tentativasFalhas: chamadas.filter((c) => c.escrita && c.falhou).map(({ pid, chamada, caminhos, args }) => ({ pid, chamada, caminhos, args })), leiturasPorPrefixo: prefixos };
}

function autoteste() {
  const area = '/tmp/safework-imagem-1-abc';
  const rastro = [
    '100 1.0 execve("/usr/bin/node", ["node", "w.js"], 0x1) = 0',
    '100 1.1 openat(AT_FDCWD, "/app/src/workers/imagem-processador.worker.js", O_RDONLY|O_CLOEXEC) = 20',
    '101 1.2 openat(AT_FDCWD, "/tmp/safework-imagem-1-abc/vips-1-2.v", O_RDWR|O_CREAT|O_EXCL, 0600 <unfinished ...>',
    '100 1.3 openat(AT_FDCWD, "/etc/ld.so.cache", O_RDONLY|O_CLOEXEC) = 3',
    '101 1.4 <... openat resumed>) = 21',
    '101 1.5 unlink("/tmp/safework-imagem-1-abc/vips-1-2.v") = 0',
    '101 1.6 openat(AT_FDCWD, "/var/tmp/outro.tmp", O_WRONLY|O_CREAT, 0600) = -1 EACCES (Permission denied)',
    '100 1.7 mkdir("sub", 0700) = 0',
    '100 1.8 rename("/tmp/safework-imagem-1-abc/a", "/tmp/fora/b") = 0',
  ].join('\n');
  const r = analisarRastro(rastro, { area, cwd: area });
  const esperado = { linhasDoRastro: 9, chamadasDeArquivo: 7, aberturasParaLeitura: 2, escritasOuCriacoesDentroDaArea: 3, escritasOuCriacoesForaDaArea: 1, tentativasDeEscritaFalhas: 1 };
  const ok = JSON.stringify(r.resumo) === JSON.stringify(esperado) && r.efeitos[0].caminhos[0] === `${area}/vips-1-2.v` && r.efeitos[2].caminhos[0] === `${area}/sub`;
  process.stdout.write(`${JSON.stringify({ autoteste: ok ? 'OK' : 'FALHOU', obtido: r.resumo, esperado }, null, 1)}\n`);
  return ok ? 0 : 1;
}

/* ---------------------------------------------------------------- ensaio */

function iniciarComRastreador(rastro) {
  return (comando, argumentos, opcoes) => spawn(STRACE, ['-f', '-ttt', '-s', '512', '-o', rastro, '-e', 'trace=file,process', '--', comando, ...argumentos], opcoes);
}

async function executarCenario(entrada, { rastrosDir, comRastreador, parametros }) {
  const rastro = path.join(rastrosDir, `${entrada.nome}.strace`);
  const limpezas = [];
  let area = null;
  let memoria = null;
  let pidRaiz = null;
  const spawnarBase = comRastreador ? iniciarComRastreador(rastro) : spawn;
  const spawnar = (comando, argumentos, opcoes) => {
    area = opcoes.cwd;
    const filho = spawnarBase(comando, argumentos, opcoes);
    pidRaiz = filho.pid ?? null;
    memoria = monitorarMemoria(pidRaiz);
    return filho;
  };
  const processador = servico.criarProcessadorDeImagens({ parametros, spawnar, observarLimpeza: (l) => limpezas.push(l) });
  const bytes = fs.readFileSync(entrada.arquivo);
  const t0 = Date.now();
  let resultado;
  try {
    const r = await processador.processar(bytes);
    resultado = { ok: true, variantes: { mestre: r.mestre.length, exibicao: r.exibicao.length, miniatura: r.miniatura.length } };
  } catch (erro) {
    resultado = { ok: false, codigo: erro && erro.codigo ? String(erro.codigo) : 'ERRO_SEM_CODIGO', recusaPublica: !!(erro && erro.codigo && String(erro.codigo).startsWith('IMAGEM')) };
  }
  const duracaoMs = Date.now() - t0;
  const mem = memoria ? memoria.parar() : { disponivel: false };
  const saida = { cenario: entrada.nome, entrada: { formato: entrada.formato, largura: entrada.largura, altura: entrada.altura, bytes: entrada.bytes, sha256: entrada.sha256 }, area, pidRaiz, duracaoMs, resultado, memoria: mem, limpezas };
  if (comRastreador) {
    let texto = '';
    try { texto = fs.readFileSync(rastro, 'utf8'); } catch { texto = ''; }
    saida.rastro = { arquivo: path.basename(rastro), bytes: Buffer.byteLength(texto), sha256: sha256(texto) };
    saida.analise = analisarRastro(texto, { area, cwd: area });
    const viuWorker = /openat\(AT_FDCWD, "[^"]*imagem-processador\.worker\.js", O_RDONLY/.test(texto);
    saida.rastreador = { operante: saida.analise.resumo.linhasDoRastro > 50 && viuWorker, viuLeituraDoWorker: viuWorker };
    saida.veredito = !saida.rastreador.operante ? 'RASTREADOR_INOPERANTE'
      : saida.analise.resumo.escritasOuCriacoesDentroDaArea > 0 || saida.analise.resumo.escritasOuCriacoesForaDaArea > 0 ? 'ESCRITA_OBSERVADA' : 'SEM_ESCRITA_OBSERVADA_NESTE_CENARIO';
  } else {
    saida.veredito = 'NAO_RASTREADO';
  }
  return saida;
}

async function principal() {
  if (temFlag('--autoteste')) { process.exit(autoteste()); }
  const saidaDir = argumento('--saida');
  if (!saidaDir || !path.isAbsolute(saidaDir)) { process.stderr.write('uso: --saida <diretório absoluto NOVO> [--sem-rastreador]\n'); process.exit(1); }
  if (fs.existsSync(saidaDir)) { process.stderr.write(`recusado: ${saidaDir} já existe\n`); process.exit(1); }
  const comRastreador = !temFlag('--sem-rastreador');
  if (comRastreador && (process.platform !== 'linux' || !fs.existsSync(STRACE))) { process.stderr.write(`rastreador exige Linux com ${STRACE}; use --sem-rastreador para ensaio de forma\n`); process.exit(2); }
  fs.mkdirSync(saidaDir, { mode: 0o700 });
  const rastrosDir = path.join(saidaDir, 'rastros');
  fs.mkdirSync(rastrosDir, { mode: 0o700 });
  const parametros = servico.parametrosDoProcessamento();
  const ambiente = servico.ambienteDoFilho();
  const entradas = await gerarEntradas(path.join(saidaDir, 'entradas'), parametros.entradaMaxBytes);

  const cenarios = [];
  for (const e of entradas) {
    if (!e.dentroDoLimite) { cenarios.push({ cenario: e.nome, entrada: e, veredito: 'ENTRADA_ACIMA_DO_LIMITE_NAO_EXECUTADA' }); continue; }
    cenarios.push(await executarCenario(e, { rastrosDir, comRastreador, parametros }));
    process.stdout.write(`${e.nome}: ${cenarios[cenarios.length - 1].veredito}\n`);
  }
  const sobrasNoTmp = fs.readdirSync(os.tmpdir()).filter((n) => n.startsWith('safework-imagem-'));
  const relatorio = {
    geradoEm: new Date().toISOString(),
    plataforma: { node: process.version, platform: process.platform, arch: process.arch, release: os.release(), sharp: sharp.versions.sharp, libvips: sharp.versions.vips, strace: comRastreador ? STRACE : null, ptraceScope: (() => { try { return fs.readFileSync('/proc/sys/kernel/yama/ptrace_scope', 'utf8').trim(); } catch { return null; } })() },
    metodo: {
      rastreador: comRastreador ? 'strace -f -ttt -s 512 -e trace=file,process (segue filhos e fios), iniciado no lugar do node pelo próprio serviço' : 'nenhum (ensaio de forma)',
      memoria: 'pico de VmHWM por processo e pico da soma de VmRSS da árvore do filho, amostrados a cada 20 ms em /proc (só Linux)',
      limites: ['conjunto finito de cenários: não prova ausência universal de temporários', 'strace observa chamadas de sistema do filho; não observa o que o kernel faz com páginas anônimas (mmap) nem swap', 'controle positivo (limiar reduzido) NÃO executado, por decisão'],
    },
    ambienteDoFilho: ambiente, parametros, tmpdirDoHost: os.tmpdir(), sobrasNoTmpAoFim: sobrasNoTmp, cenarios,
  };
  const rastreadorOperante = !comRastreador || cenarios.every((c) => !c.rastreador || c.rastreador.operante);
  relatorio.conclusao = {
    rastreadorOperante,
    cenariosComEscritaObservada: cenarios.filter((c) => c.veredito === 'ESCRITA_OBSERVADA').map((c) => c.cenario),
    cenariosSemEscritaObservada: cenarios.filter((c) => c.veredito === 'SEM_ESCRITA_OBSERVADA_NESTE_CENARIO').map((c) => c.cenario),
    cenariosNaoExecutados: cenarios.filter((c) => c.veredito.startsWith('ENTRADA_ACIMA')).map((c) => c.cenario),
    todasAsAreasRemovidas: cenarios.every((c) => !c.limpezas || c.limpezas.some((l) => l.removida === true)),
    observacao: 'Veredito por cenário; ausência universal NÃO é afirmada. D-12 continua pendente até decisão humana sobre a suficiência destas evidências.',
  };
  fs.writeFileSync(path.join(saidaDir, 'relatorio-ensaio-d12.json'), `${JSON.stringify(relatorio, null, 1)}\n`, { flag: 'wx', mode: 0o600 });
  const manifesto = [];
  const andar = (dir, rel) => { for (const e of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) { const p = path.join(dir, e.name); const r = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) andar(p, r); else if (r !== 'MANIFESTO-SHA256.txt') manifesto.push(`${sha256(fs.readFileSync(p))}  ${r}`); } };
  andar(saidaDir, '');
  fs.writeFileSync(path.join(saidaDir, 'MANIFESTO-SHA256.txt'), `${manifesto.join('\n')}\n`, { flag: 'wx', mode: 0o600 });
  process.stdout.write(`${JSON.stringify(relatorio.conclusao, null, 1)}\n`);
  process.exit(rastreadorOperante ? 0 : 2);
}

principal().catch((erro) => { process.stderr.write(`ERRO DO ENSAIO: ${erro && erro.message}\n`); process.exit(1); });
