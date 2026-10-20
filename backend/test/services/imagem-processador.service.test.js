'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { Writable, PassThrough } = require('node:stream');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const F = require('../helpers/imagens-reais');

/**
 * Biblioteca de Imagens, Unidade 5C-4 (D-C6) — O PROCESSADOR REAL, LADO DA API (src/services/imagem-processador.service.js): decodificar imagem enviada por cliente roda em um
 * PROCESSO FILHO controlado. Este arquivo prova o lado de quem chama: o que o filho recebe (só os bytes e números), com que ambiente (sem segredo), como é encerrado
 * (SIGKILL no prazo, sem zumbi), como cada falha vira erro (recusa pública, indisponibilidade ou erro interno) e que a resposta do filho nunca é aceita sem conferência.
 * Parte dos testes usa o filho REAL (o worker); parte usa filhos de teste em test/helpers/filhos/ e um `spawnar` falso.
 */

const carregar = (caminho, trecho) => {
  try { return require(caminho); } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && String(erro.message).includes(trecho)) throw new Error(`módulo ainda não implementado: ${caminho}`);
    throw erro;
  }
};
const S = () => carregar('../../src/services/imagem-processador.service', 'imagem-processador.service');
const C = () => carregar('../../src/utils/imagem-container', 'imagem-container');
const Q = () => carregar('../../src/utils/imagem-quadro', 'imagem-quadro');
const teste = (nome, fn) => test(nome, { timeout: 90000 }, fn);
const FILHOS = path.join(__dirname, '..', 'helpers', 'filhos');
const filho = (nome) => path.join(FILHOS, nome);
const MIB = 1024 * 1024;

const CODIGOS_INTERNOS = Object.freeze({
  SINAL: 'IMAGEM_FILHO_SINAL', CODIGO: 'IMAGEM_FILHO_CODIGO_SAIDA', RESPOSTA: 'IMAGEM_FILHO_RESPOSTA_INVALIDA', EXCESSO: 'IMAGEM_FILHO_SAIDA_EXCESSIVA', ENCERRADO: 'IMAGEM_FILHO_ENCERRADO',
});
const recusaCom = (codigo) => (erro) => {
  assert.ok(erro instanceof C().ErroDeImagem, `esperava ErroDeImagem e veio ${erro?.name}: ${erro?.message}`);
  assert.equal(erro.codigo, codigo);
  return true;
};
const internoCom = (codigo) => (erro) => {
  assert.ok(erro instanceof Error && !(erro instanceof C().ErroDeImagem), `esperava erro interno e veio ${erro?.name}: ${erro?.message}`);
  assert.equal(erro.codigo, codigo);
  return true;
};
const dormir = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const vivo = (pid) => { try { process.kill(pid, 0); return true; } catch (erro) { if (erro.code === 'ESRCH') return false; throw erro; } };
async function esperarAte(condicao, ms = 5000, passo = 20) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) { if (await condicao()) return true; await dormir(passo); }
  return false;
}
const contar = (tipo) => process.getActiveResourcesInfo().filter((r) => r === tipo).length;

describe('parametrosDoProcessamento — D-C5 e D-C6 como números', () => {
  teste('PRS-01 — os valores aprovados: entrada 320 a 4096 e 8.388.608 px, 2 MiB; mestre 1024 (4 MiB), exibição 640 (512 KiB), miniatura 320 (64 KiB); 10 s de tempo interno', () => {
    assert.deepEqual(JSON.parse(JSON.stringify(S().parametrosDoProcessamento())), {
      ladoMin: 320, ladoMax: 4096, pixelsMax: 8388608, entradaMaxBytes: 2 * MIB, timeoutSegundos: 10,
      mestre: { lado: 1024, bytesMax: 4 * MIB }, exibicao: { lado: 640, bytesMax: 512 * 1024 }, miniatura: { lado: 320, bytesMax: 65536 },
    });
  });

  teste('PRS-02 — sobrescritas por seção (só para teste e uso interno); chave desconhecida ou valor fora de faixa → TypeError; o resultado é JSON puro', () => {
    const p = S().parametrosDoProcessamento(undefined, { pixelsMax: 1000000, mestre: { bytesMax: 5000 } });
    assert.deepEqual([p.pixelsMax, p.mestre.bytesMax, p.mestre.lado, p.exibicao.lado], [1000000, 5000, 1024, 640]);
    assert.deepEqual(JSON.parse(JSON.stringify(p)), p);
    for (const ruim of [{ desconhecida: 1 }, { mestre: { cor: 1 } }, { pixelsMax: -1 }, { timeoutSegundos: 0 }, { exibicao: { bytesMax: 'x' } }]) assert.throws(() => S().parametrosDoProcessamento(undefined, ruim), TypeError, JSON.stringify(ruim));
  });
});

describe('criarProcessadorDeImagens — o filho real', () => {
  teste('PRS-03 — PNG, JPEG e WebP válidos passam pelo filho REAL e voltam como o conjunto do contrato; nenhum filho sobra; nenhum temporizador sobra', async () => {
    const base = { timeout: contar('Timeout') };
    const processador = S().criarProcessadorDeImagens();
    for (const entrada of [await F.png(640, 480), await F.jpeg(640, 480), await F.webp(640, 480)]) {
      const r = await processador.processar(entrada);
      assert.deepEqual([r.formato, r.largura, r.altura], ['PNG', 1024, 1024]);
      const [mm, me, mi] = await Promise.all([F.metadados(r.mestre), F.metadados(r.exibicao), F.metadados(r.miniatura)]);
      assert.deepEqual([mm.format, mm.width, mm.height, me.format, me.width, me.height, mi.format, mi.width, mi.height], ['png', 1024, 1024, 'webp', 640, 640, 'webp', 320, 320]);
    }
    assert.deepEqual(processador.ativos(), []);
    assert.equal(contar('Timeout'), base.timeout, 'o prazo externo é sempre cancelado');
  });

  teste('PRS-04 — a recusa do filho chega como ErroDeImagem pública (PNG com CRC ruim → IMAGEM_INVALIDA), sem a mensagem do libvips', async () => {
    let iniciados = 0;
    const processador = S().criarProcessadorDeImagens({ spawnar: (...a) => { iniciados += 1; return childProcess.spawn(...a); } });
    const ruim = F.pngComCrcCorrompido(await F.png(400, 320, { padrao: 'ruido' }));
    await assert.rejects(processador.processar(ruim), (erro) => { recusaCom('IMAGEM_INVALIDA')(erro); assert.ok(!/vips|libpng/i.test(erro.message)); return true; });
    assert.equal(iniciados, 1);
    assert.deepEqual(processador.ativos(), []);
  });

  teste('PRS-05 — o que é recusável só pelos bytes NÃO gasta um processo: formato, animação, dimensão declarada, truncada e poliglota perigoso são recusados antes de iniciar o filho', async () => {
    const processador = S().criarProcessadorDeImagens({ spawnar: () => { throw new Error('não podia iniciar um filho para isto'); } });
    const casos = [
      [Buffer.alloc(0), 'IMAGEM_FORMATO_NAO_SUPORTADO'], [F.svg(), 'IMAGEM_FORMATO_NAO_SUPORTADO'], [await F.gif(), 'IMAGEM_FORMATO_NAO_SUPORTADO'], [F.apng(await F.png(400, 320)), 'IMAGEM_ANIMADA_NAO_SUPORTADA'],
      [F.pngComDimensoesDeclaradas(60000, 60000), 'IMAGEM_DIMENSOES_INVALIDAS'], [F.truncar(await F.png(400, 320, { padrao: 'ruido' }), 0.5), 'IMAGEM_INVALIDA'], [Buffer.concat([await F.png(400, 320), F.zip()]), 'IMAGEM_FORMATO_NAO_SUPORTADO'],
    ];
    for (const [entrada, codigo] of casos) await assert.rejects(processador.processar(entrada), recusaCom(codigo), codigo);
  });

  teste('PRS-06 — argumentos errados são erro de programação (TypeError); entrada acima do máximo é recusada sem iniciar o filho', async () => {
    const processador = S().criarProcessadorDeImagens({ spawnar: () => { throw new Error('não podia iniciar um filho'); } });
    for (const ruim of ['texto', null, undefined, 42, new Uint8Array(8)]) await assert.rejects(processador.processar(ruim), TypeError);
    const arquivo = await F.png(400, 320);
    const apertado = S().criarProcessadorDeImagens({ parametros: S().parametrosDoProcessamento(undefined, { entradaMaxBytes: arquivo.length - 1 }), spawnar: () => { throw new Error('não podia iniciar um filho'); } });
    await assert.rejects(apertado.processar(arquivo), recusaCom('IMAGEM_INVALIDA'));
  });

  teste('PRS-07 — opções inválidas na criação são erro de programação (TypeError)', () => {
    const { criarProcessadorDeImagens } = S();
    for (const ruim of [{ prazoExternoMs: 0 }, { prazoExternoMs: -1 }, { prazoExternoMs: 1.5 }, { prazoExternoMs: '1000' }, { spawnar: 'x' }, { caminhoDoFilho: 'relativo.js' }, { caminhoDoFilho: 42 }, { parametros: { x: 1 } }, { parametros: 'x' }]) {
      assert.throws(() => criarProcessadorDeImagens(ruim), TypeError, JSON.stringify(ruim));
    }
    assert.doesNotThrow(() => criarProcessadorDeImagens());
    assert.doesNotThrow(() => criarProcessadorDeImagens({ prazoExternoMs: 1000 }));
  });

  teste('PRS-08 — os padrões aprovados: o filho é o worker real, o prazo externo é de 15 s e o tempo interno é de 10 s', () => {
    const { CAMINHO_DO_FILHO, PRAZO_EXTERNO_PADRAO_MS } = S();
    assert.equal(path.isAbsolute(CAMINHO_DO_FILHO), true);
    assert.equal(CAMINHO_DO_FILHO, path.join(__dirname, '..', '..', 'src', 'workers', 'imagem-processador.worker.js'));
    assert.equal(fs.existsSync(CAMINHO_DO_FILHO), true);
    assert.equal(PRAZO_EXTERNO_PADRAO_MS, 15000);
  });
});

describe('criarProcessadorDeImagens — o que o filho recebe', () => {
  function criarFilhoFalso({ responder = 'recusa' } = {}) {
    const entrada = [];
    const f = new EventEmitter();
    f.pid = 424242;
    f.stdin = new Writable({ write(chunk, _enc, cb) { entrada.push(Buffer.from(chunk)); cb(); } });
    f.stdout = new PassThrough();
    f.stderr = new PassThrough();
    // Como no Node de verdade, 'close' só vem depois que a saída terminou de ser lida.
    const encerrar = (codigo, sinal, quadro) => setImmediate(() => {
      f.stdout.once('end', () => { f.emit('exit', codigo, sinal); f.emit('close', codigo, sinal); });
      f.stderr.end();
      f.stdout.end(quadro);
    });
    f.kill = (sinal) => { f.sinal = sinal; encerrar(null, sinal); return true; };
    f.entrada = () => Buffer.concat(entrada);
    f.stdin.on('finish', () => { if (responder === 'recusa') encerrar(0, null, Q().serializarRecusa('IMAGEM_INVALIDA')); });
    return f;
  }

  teste('PRS-09 — o filho recebe SÓ os bytes (pela entrada padrão) e os parâmetros numéricos (um argumento JSON); sem shell, sem segredo, em pasta neutra, com limite de memória', async () => {
    const chamadas = [];
    const falso = criarFilhoFalso();
    const processador = S().criarProcessadorDeImagens({ spawnar: (comando, argumentos, opcoes) => { chamadas.push({ comando, argumentos, opcoes }); return falso; } });
    const marcador = 'MARCADOR-NOS-BYTES-DO-ENVIO';
    const arquivo = F.inserirPedacoPng(await F.png(400, 320), 'tEXt', Buffer.from(`k\0${marcador}`));
    await assert.rejects(processador.processar(arquivo), recusaCom('IMAGEM_INVALIDA'));
    assert.equal(chamadas.length, 1);
    const { comando, argumentos, opcoes } = chamadas[0];
    assert.equal(comando, process.execPath);
    assert.ok(argumentos.some((a) => /^--max-old-space-size=\d+$/.test(a)), 'limite de memória do JavaScript');
    assert.ok(argumentos.includes('--disallow-code-generation-from-strings'));
    assert.equal(argumentos[argumentos.length - 2], S().CAMINHO_DO_FILHO);
    assert.deepEqual(JSON.parse(argumentos[argumentos.length - 1]), JSON.parse(JSON.stringify(S().parametrosDoProcessamento())));
    assert.ok(argumentos.every((a) => !String(a).includes(marcador)), 'nenhum byte do envio vai em argumento');
    assert.ok(falso.entrada().equals(arquivo), 'os bytes do envio vão inteiros e só pela entrada padrão');
    assert.equal(opcoes.shell, false);
    assert.deepEqual(opcoes.stdio, ['pipe', 'pipe', 'pipe']);
    assert.deepEqual(opcoes.env, S().ambienteDoFilho());
    assert.equal(fs.realpathSync(opcoes.cwd), fs.realpathSync(os.tmpdir()));
    assert.ok(!opcoes.detached);
  });

  teste('PRS-10 — ambienteDoFilho: só as variáveis necessárias e fixas; nenhum segredo da aplicação passa, mesmo presente no ambiente do processo', () => {
    const sentinelas = { DB_PASSWORD: 's1', LOGIN_COOLDOWN_HMAC_SECRET: 's2', COOKIE_SECRET: 's3', AWS_SECRET_ACCESS_KEY: 's4', SESSION_SECRET: 's5', NODE_OPTIONS: '--inspect=0.0.0.0:9229', TURNSTILE_SECRET: 's6', SMTP_PASSWORD: 's7' };
    const anteriores = Object.fromEntries(Object.keys(sentinelas).map((k) => [k, process.env[k]]));
    Object.assign(process.env, sentinelas);
    try {
      const env = S().ambienteDoFilho();
      assert.deepEqual(Object.keys(env).sort(), ['MALLOC_ARENA_MAX', 'PATH', 'TMPDIR', 'UV_THREADPOOL_SIZE', 'VIPS_BLOCK_UNTRUSTED']);
      assert.equal(env.VIPS_BLOCK_UNTRUSTED, '1');
      assert.equal(env.PATH, '/usr/bin:/bin');
      assert.ok(Number(env.UV_THREADPOOL_SIZE) >= 2 && Number(env.UV_THREADPOOL_SIZE) <= 8);
      const texto = JSON.stringify(env);
      for (const valor of Object.values(sentinelas)) assert.ok(!texto.includes(valor));
      assert.ok(!Object.hasOwn(env, 'NODE_OPTIONS'));
    } finally {
      for (const [k, v] of Object.entries(anteriores)) { if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    }
  });

  teste('PRS-11 — o filho REAL, aberto com as opções de verdade, só enxerga o ambiente combinado, só o JSON como argumento, a memória limitada e a pasta neutra', () => {
    const { montarExecucaoDoFilho } = S();
    const execucao = montarExecucaoDoFilho({ caminhoDoFilho: filho('imprime-ambiente.js') });
    const sentinela = 'SEGREDO-QUE-NAO-PODE-VAZAR';
    const saida = childProcess.execFileSync(execucao.comando, execucao.argumentos, { ...execucao.opcoes, env: { ...execucao.opcoes.env }, encoding: 'utf8' });
    const visto = JSON.parse(saida);
    const permitidas = ['MALLOC_ARENA_MAX', 'PATH', 'TMPDIR', 'UV_THREADPOOL_SIZE', 'VIPS_BLOCK_UNTRUSTED', '__CF_USER_TEXT_ENCODING'];
    assert.ok(visto.chaves.every((k) => permitidas.includes(k)), `variáveis vistas pelo filho: ${visto.chaves}`);
    assert.ok(!JSON.stringify(visto).includes(sentinela));
    assert.equal(visto.argv.length, 1);
    assert.deepEqual(JSON.parse(visto.argv[0]), JSON.parse(JSON.stringify(S().parametrosDoProcessamento())));
    assert.ok(visto.execArgv.some((a) => a.startsWith('--max-old-space-size=')) && visto.execArgv.includes('--disallow-code-generation-from-strings'));
    assert.equal(fs.realpathSync(visto.cwd), fs.realpathSync(os.tmpdir()));
  });
});

describe('criarProcessadorDeImagens — prazo, encerramento e identificação', () => {
  teste('PRS-12 — prazo externo: um filho que trava é MORTO por SIGKILL, o processador recusa com IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO, o processo desaparece e nada sobra', async () => {
    const base = contar('Timeout');
    const processador = S().criarProcessadorDeImagens({ caminhoDoFilho: filho('travado.js'), prazoExternoMs: 400 });
    const t0 = Date.now();
    const execucao = processador.processar(await F.png(400, 320)).then(() => null, (e) => e);
    assert.ok(await esperarAte(() => processador.ativos().length === 1), 'o filho apareceu em ativos()');
    const [pid] = processador.ativos();
    assert.ok(Number.isInteger(pid) && pid > 0 && vivo(pid));
    const erro = await execucao;
    recusaCom('IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO')(erro);
    const gasto = Date.now() - t0;
    assert.ok(gasto >= 350 && gasto < 4000, `terminou em ${gasto} ms`);
    assert.ok(await esperarAte(() => !vivo(pid), 3000), 'o processo morreu de verdade');
    assert.deepEqual(processador.ativos(), []);
    assert.equal(contar('Timeout'), base);
  });

  teste('PRS-13 — o encerramento não depende de cooperação: um filho que ignora SIGTERM também morre no prazo', async () => {
    const criados = [];
    const spawnar = (...argumentos) => { const f = childProcess.spawn(...argumentos); criados.push(f); return f; };
    const processador = S().criarProcessadorDeImagens({ caminhoDoFilho: filho('ignora-sigterm.js'), prazoExternoMs: 400, spawnar });
    try {
      const execucao = processador.processar(await F.png(400, 320)).then(() => null, (e) => e);
      assert.ok(await esperarAte(() => processador.ativos().length === 1));
      const [pid] = processador.ativos();
      recusaCom('IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO')(await execucao);
      assert.ok(await esperarAte(() => !vivo(pid), 3000));
    } finally {
      // Limpeza: o filho que ignora SIGTERM e sobrar vivo (se o encerramento falhar) não pode segurar o processo do arquivo; só os filhos criados por ESTE teste são encerrados.
      for (const f of criados) { if (f.exitCode === null && f.signalCode === null) f.kill('SIGKILL'); }
    }
  });

  teste('PRS-14 — encerrarTodos: mata os filhos em andamento, espera a morte, e quem estava processando recebe erro interno IMAGEM_FILHO_ENCERRADO', async () => {
    const processador = S().criarProcessadorDeImagens({ caminhoDoFilho: filho('travado.js'), prazoExternoMs: 60000 });
    const execucoes = [processador.processar(await F.png(400, 320)), processador.processar(await F.jpeg(400, 320))].map((p) => p.then(() => null, (e) => e));
    assert.ok(await esperarAte(() => processador.ativos().length === 2));
    const pids = processador.ativos();
    await processador.encerrarTodos();
    for (const pid of pids) assert.equal(vivo(pid), false);
    assert.deepEqual(processador.ativos(), []);
    for (const erro of await Promise.all(execucoes)) internoCom(CODIGOS_INTERNOS.ENCERRADO)(erro);
  });
});

describe('criarProcessadorDeImagens — falhas do filho', () => {
  const executarCom = async (script, opcoes = {}) => {
    const processador = S().criarProcessadorDeImagens({ caminhoDoFilho: filho(script), prazoExternoMs: 20000, ...opcoes });
    const erro = await processador.processar(await F.png(400, 320)).then(() => null, (e) => e);
    assert.deepEqual(processador.ativos(), [], 'nenhum filho sobra');
    return { erro, processador };
  };

  teste('PRS-15 — morte por sinal, saída com código ruim e escrita na entrada de um filho já morto (EPIPE) são erros INTERNOS distintos, nunca recusa de imagem', async () => {
    internoCom(CODIGOS_INTERNOS.SINAL)((await executarCom('morre-por-sinal.js')).erro);
    internoCom(CODIGOS_INTERNOS.CODIGO)((await executarCom('sai-com-codigo.js')).erro);
    const grande = S().criarProcessadorDeImagens({ caminhoDoFilho: filho('sai-sem-ler.js'), prazoExternoMs: 20000 });
    const volumoso = await F.png(700, 700, { padrao: 'ruido' });
    assert.ok(volumoso.length > 1024 * 1024 && volumoso.length < 2 * 1024 * 1024, `entrada de ${volumoso.length} bytes: grande o bastante para estourar o buffer do pipe e ainda dentro dos 2 MiB`);
    internoCom(CODIGOS_INTERNOS.CODIGO)(await grande.processar(volumoso).then(() => null, (e) => e));
  });

  teste('PRS-16 — o filho que não consegue carregar o sharp (código 3) vira IMAGENS_INDISPONIVEL; falha ao iniciar o processo também', async () => {
    internoCom('IMAGENS_INDISPONIVEL')((await executarCom('sem-sharp.js')).erro);
    for (const spawnar of [() => { throw Object.assign(new Error('spawn EAGAIN'), { code: 'EAGAIN' }); }, () => {
      const f = new EventEmitter();
      f.pid = undefined; f.stdin = new PassThrough(); f.stdout = new PassThrough(); f.stderr = new PassThrough(); f.kill = () => true;
      setImmediate(() => f.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return f;
    }]) {
      const processador = S().criarProcessadorDeImagens({ spawnar });
      internoCom('IMAGENS_INDISPONIVEL')(await processador.processar(await F.png(400, 320)).then(() => null, (e) => e));
      assert.deepEqual(processador.ativos(), []);
    }
  });

  teste('PRS-17 — nada do que o filho escreve na saída de erro, nem caminhos, chega a quem chamou', async () => {
    const { erro } = await executarCom('escreve-stderr-e-cai.js');
    internoCom(CODIGOS_INTERNOS.CODIGO)(erro);
    for (const texto of [erro.message, String(erro.stack), JSON.stringify({ ...erro })]) assert.ok(!/SEGREDO-NO-STDERR|\/home\/usuario/.test(texto));
  });

  teste('PRS-18 — resposta fora do protocolo (lixo, quadro cortado, recusa com código desconhecido) → IMAGEM_FILHO_RESPOSTA_INVALIDA; recusa bem formada → ErroDeImagem pública', async () => {
    for (const script of ['lixo.js', 'quadro-truncado.js', 'recusa-codigo-estranho.js']) internoCom(CODIGOS_INTERNOS.RESPOSTA)((await executarCom(script)).erro);
    recusaCom('IMAGEM_INVALIDA')((await executarCom('recusa-valida.js')).erro);
  });

  teste('PRS-19 — saída gigante: o processador corta no teto, MATA o filho e erra com IMAGEM_FILHO_SAIDA_EXCESSIVA (não acumula memória)', async () => {
    const processador = S().criarProcessadorDeImagens({ caminhoDoFilho: filho('saida-gigante.js'), prazoExternoMs: 20000 });
    const antes = process.memoryUsage().rss;
    const execucao = processador.processar(await F.png(400, 320)).then(() => null, (e) => e);
    assert.ok(await esperarAte(() => processador.ativos().length === 1));
    const [pid] = processador.ativos();
    internoCom(CODIGOS_INTERNOS.EXCESSO)(await execucao);
    assert.ok(await esperarAte(() => !vivo(pid), 3000), 'o filho foi morto');
    assert.ok(process.memoryUsage().rss - antes < 80 * MIB, 'não guardou os 40 MiB que o filho despejou');
  });

  teste('PRS-20 — o processador NÃO confia no sucesso do filho: sucesso válido passa; medida errada, formato errado, metadado ou carga depois do fim → IMAGEM_FILHO_RESPOSTA_INVALIDA; acima do teto também', async () => {
    const ok = S().criarProcessadorDeImagens({ caminhoDoFilho: filho('sucesso-valido.js'), prazoExternoMs: 20000 });
    const r = await ok.processar(await F.png(400, 320));
    assert.deepEqual([r.formato, r.largura, r.altura], ['PNG', 1024, 1024]);
    for (const script of ['sucesso-mestre-pequeno.js', 'sucesso-exibicao-em-png.js', 'sucesso-mestre-com-metadados.js', 'sucesso-carga-depois-do-fim.js']) {
      internoCom(CODIGOS_INTERNOS.RESPOSTA)((await executarCom(script)).erro);
    }
    const apertado = S().criarProcessadorDeImagens({ caminhoDoFilho: filho('sucesso-valido.js'), prazoExternoMs: 20000, parametros: S().parametrosDoProcessamento(undefined, { mestre: { bytesMax: 100 } }) });
    internoCom(CODIGOS_INTERNOS.RESPOSTA)(await apertado.processar(await F.png(400, 320)).then(() => null, (e) => e));
  });
});

describe('criarProcessadorDeImagens — concorrência e limpeza', () => {
  teste('PRS-21 — vários envios simultâneos pelo filho real: todos voltam certos, cada um com o seu filho, e no fim não há filho nem temporizador', async () => {
    const base = contar('Timeout');
    const processador = S().criarProcessadorDeImagens();
    const entradas = await Promise.all([F.png(500, 400), F.jpeg(500, 400), F.webp(500, 400), F.png(700, 500), F.jpeg(300 + 100, 400), F.webp(900, 600)]);
    let maximo = 0;
    const sondar = setInterval(() => { maximo = Math.max(maximo, processador.ativos().length); }, 5);
    try {
      const resultados = await Promise.all(entradas.map((e) => processador.processar(e)));
      for (const r of resultados) assert.deepEqual([r.largura, r.altura], [1024, 1024]);
    } finally { clearInterval(sondar); }
    assert.ok(maximo >= 2, `houve concorrência de verdade (máximo observado ${maximo})`);
    assert.deepEqual(processador.ativos(), []);
    assert.equal(contar('Timeout'), base);
  });

  teste('PRS-22 — falhas em sequência não acumulam: 8 recusas de filho real e 4 mortes por prazo deixam ativos() vazio e sem temporizador', async () => {
    const base = contar('Timeout');
    const real = S().criarProcessadorDeImagens();
    const ruim = F.pngComCrcCorrompido(await F.png(400, 320, { padrao: 'ruido' }));
    for (let i = 0; i < 8; i += 1) await assert.rejects(real.processar(ruim), recusaCom('IMAGEM_INVALIDA'));
    const travado = S().criarProcessadorDeImagens({ caminhoDoFilho: filho('travado.js'), prazoExternoMs: 150 });
    for (let i = 0; i < 4; i += 1) await assert.rejects(travado.processar(await F.png(400, 320)), recusaCom('IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO'));
    assert.deepEqual([real.ativos(), travado.ativos()], [[], []]);
    assert.equal(contar('Timeout'), base);
  });

  teste('PRS-23 — o filho REAL também se defende sozinho: entrada acima do máximo é recusada por ele (quadro de recusa IMAGEM_INVALIDA), sem decodificar nada', async () => {
    const execucao = S().montarExecucaoDoFilho({ parametros: S().parametrosDoProcessamento(undefined, { entradaMaxBytes: 1000 }) });
    const filhoReal = childProcess.spawn(execucao.comando, execucao.argumentos, execucao.opcoes);
    const saidas = [];
    filhoReal.stdout.on('data', (b) => saidas.push(b));
    filhoReal.stderr.on('data', () => {});
    filhoReal.stdin.on('error', () => {});
    filhoReal.stdin.end(Buffer.alloc(5000, 7));
    const [codigo, sinal] = await new Promise((resolve) => { filhoReal.once('close', (c, s) => resolve([c, s])); });
    assert.deepEqual([codigo, sinal], [0, null]);
    assert.deepEqual(Q().lerQuadro(Buffer.concat(saidas), { mestreMax: MIB, exibicaoMax: MIB, miniaturaMax: MIB }), { ok: false, codigo: 'IMAGEM_INVALIDA' });
  });

  teste('PRS-25 — o relógio de sobrevivência do filho (saída com o código 124) vale como tempo esgotado, não como erro interno', async () => {
    const processador = S().criarProcessadorDeImagens({ caminhoDoFilho: filho('sai-com-124.js'), prazoExternoMs: 20000 });
    recusaCom('IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO')(await processador.processar(await F.png(400, 320)).then(() => null, (e) => e));
    assert.deepEqual(processador.ativos(), []);
  });

  teste('PRS-24 — se o filho NÃO morrer depois do SIGKILL, o processador desiste da espera (prazo de graça) e erra mesmo assim: nunca fica pendurado segurando a vaga', async () => {
    const f = new EventEmitter();
    f.pid = 777777;
    f.stdin = new Writable({ write(_c, _e, cb) { cb(); } });
    f.stdout = new PassThrough();
    f.stderr = new PassThrough();
    f.kill = () => true;
    const base = contar('Timeout');
    const processador = S().criarProcessadorDeImagens({ spawnar: () => f, prazoExternoMs: 100, esperaPelaMorteMs: 100 });
    const t0 = Date.now();
    await assert.rejects(processador.processar(await F.png(400, 320)), recusaCom('IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO'));
    const gasto = Date.now() - t0;
    assert.ok(gasto >= 180 && gasto < 3000, `terminou em ${gasto} ms`);
    assert.deepEqual(processador.ativos(), []);
    assert.equal(contar('Timeout'), base);
  });
});
