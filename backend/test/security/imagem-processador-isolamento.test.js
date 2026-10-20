'use strict';

const fs = require('node:fs');
const path = require('node:path');
const childProcess = require('node:child_process');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

/**
 * Biblioteca de Imagens, Unidade 5C-4 (D-C6) — o ISOLAMENTO do decodificador, provado no CÓDIGO: o filho só importa o que precisa (sharp e três utilitários puros), não
 * toca banco, configuração, segredos, arquivos, rede nem outros processos, e não lê o ambiente; quem chama nunca usa shell nem repassa o ambiente da aplicação; e o
 * processador só chega ao app por UM módulo (imagem-processador.ambiente, desligado por padrão: Unidade 5C-6). O filho tem relógio de sobrevivência próprio (código 124).
 * LIMITE REGISTRADO: separar por processo reduz o estrago de uma falha nativa do decodificador, mas NÃO é isolamento completo do sistema operacional (o filho roda com o
 * mesmo usuário e enxerga o mesmo sistema de arquivos e rede); proteção adicional (usuário próprio, contêiner, seccomp) é decisão de implantação.
 */

const RAIZ = path.join(__dirname, '..', '..');
const SRC = path.join(RAIZ, 'src');
const le = (...partes) => fs.readFileSync(path.join(SRC, ...partes), 'utf8');
const existe = (...partes) => fs.existsSync(path.join(SRC, ...partes));
const carregarTexto = (...partes) => {
  if (!existe(...partes)) throw new Error(`módulo ainda não implementado: src/${partes.join('/')}`);
  return le(...partes);
};
const importacoes = (texto) => [...texto.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
const semComentarios = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');

describe('isolamento do decodificador — o que o filho importa', () => {
  test('SEC-01 — o worker importa SÓ o sharp e utilitários puros do próprio projeto; nada de banco, configuração, segurança, repositórios, serviços, express, fs, rede ou processos', () => {
    const texto = semComentarios(carregarTexto('workers', 'imagem-processador.worker.js'));
    const lista = importacoes(texto);
    const permitidas = new Set(['sharp', '../utils/imagem-container', '../utils/imagem-quadro', '../utils/imagem-parametros']);
    for (const m of lista) assert.ok(permitidas.has(m), `importação não permitida no filho: ${m}`);
    for (const m of ['sharp', '../utils/imagem-container', '../utils/imagem-quadro', '../utils/imagem-parametros']) assert.ok(lista.includes(m), `o filho precisa de ${m}`);
  });

  test('SEC-02 — os utilitários que o filho usa só importam uns aos outros: nenhum acesso a arquivo, rede, processo, configuração ou ambiente', () => {
    for (const nome of ['imagem-container', 'imagem-quadro', 'imagem-parametros']) {
      const texto = semComentarios(carregarTexto('utils', `${nome}.js`));
      for (const m of importacoes(texto)) assert.ok(/^\.\/imagem-(container|quadro|parametros)$/.test(m), `${nome} importa ${m}`);
      assert.ok(!/process\.env|child_process|require\(['"]node:(fs|net|http|https|dns|vm|worker_threads)/.test(texto), nome);
    }
  });

  test('SEC-03 — o worker não lê o ambiente nem escreve em arquivo; não monta caminho, comando nem URL com dado do envio', () => {
    const texto = semComentarios(carregarTexto('workers', 'imagem-processador.worker.js'));
    assert.ok(!/process\.env/.test(texto), 'sem process.env');
    assert.ok(!/\bfs\b|writeFile|readFile|createWriteStream|createReadStream|\bexec\w*\(|\bspawn\w*\(|\bfork\(|new Worker|\beval\(|new Function|fetch\(|\.toFile\(/.test(texto), 'sem arquivo, processo, rede ou avaliação dinâmica');
  });
});

describe('isolamento do decodificador — quem chama', () => {
  test('SEC-04 — o serviço inicia o filho com spawn(process.execPath, ...), sem shell, sem exec e sem repassar o ambiente da aplicação', () => {
    const texto = semComentarios(carregarTexto('services', 'imagem-processador.service.js'));
    assert.ok(/spawn/.test(texto) && /process\.execPath/.test(texto));
    assert.ok(!/shell\s*:\s*true/.test(texto), 'sem shell');
    assert.ok(/shell\s*:\s*false/.test(texto), 'shell:false explícito');
    assert.ok(!/\bexec\(|\bexecSync\(|\bexecFile\w*\(|\bspawnSync\(/.test(texto), 'sem exec');
    assert.ok(!/\.\.\.\s*process\.env|Object\.assign\([^)]*process\.env|env\s*:\s*process\.env/.test(texto), 'sem repassar process.env');
    assert.ok(/SIGKILL/.test(texto), 'o encerramento é por SIGKILL');
    assert.ok(!/require\(['"]\.\.\/(repositories|security|config\/(database|auth|env))/.test(texto), 'sem banco nem segredo');
  });

  test('SEC-05 — o processador real só entra no app pelo módulo do ambiente: app, rotas e serviço de envio não o conhecem; controller e servidor importam apenas imagem-processador.ambiente', () => {
    for (const arquivo of [['app.js'], ['routes', 'imagem-material.routes.js'], ['services', 'imagem-material-upload.service.js']]) {
      assert.ok(!/imagem-processador/.test(le(...arquivo)), `src/${arquivo.join('/')} não pode referenciar o processador real`);
    }
    for (const arquivo of [['server.js'], ['controllers', 'imagem-material.controller.js']]) {
      const referencias = importacoes(semComentarios(le(...arquivo))).filter((m) => /imagem-processador/.test(m));
      assert.deepEqual(referencias.map((m) => path.basename(m)), ['imagem-processador.ambiente'], `src/${arquivo.join('/')}`);
    }
  });

  test('SEC-07 — um único ponto de ativação: só o módulo do ambiente importa o serviço do processador real e só ele cita IMAGENS_PROCESSADOR_REAL no código', () => {
    const arquivos = [];
    const varrer = (pasta) => {
      for (const entrada of fs.readdirSync(pasta, { withFileTypes: true })) {
        if (/ 2(\.[a-z]+)?$/.test(entrada.name)) continue;
        const caminho = path.join(pasta, entrada.name);
        if (entrada.isDirectory()) varrer(caminho);
        else if (entrada.isFile() && entrada.name.endsWith('.js')) arquivos.push(caminho);
      }
    };
    varrer(SRC);
    const relativo = (caminho) => path.relative(SRC, caminho).split(path.sep).join('/');
    const importadores = arquivos.filter((a) => importacoes(semComentarios(fs.readFileSync(a, 'utf8'))).some((m) => /imagem-processador\.service$/.test(m))).map(relativo);
    assert.deepEqual(importadores, ['services/imagem-processador.ambiente.js']);
    const leitores = arquivos.filter((a) => /IMAGENS_PROCESSADOR_REAL/.test(semComentarios(fs.readFileSync(a, 'utf8')))).map(relativo);
    assert.deepEqual(leitores, ['services/imagem-processador.ambiente.js']);
  });

  test('SEC-08 — o servidor entrega ao encerramento o MESMO processador do processo (senão os filhos ficariam órfãos na saída) e o controller de produção o recebe do mesmo módulo', () => {
    const servidor = semComentarios(le('server.js'));
    assert.match(servidor, /criarEncerramento\(\{[^}]*\bprocessos:\s*processadorDoProcesso\(\)/);
    const controller = semComentarios(le('controllers', 'imagem-material.controller.js'));
    assert.match(controller, /const imagemMaterialController = criarImagemMaterialController\(\{[^}]*\bprocessador:\s*processadorDoProcesso\(\)/);
  });
});

describe('isolamento do decodificador — relógio de sobrevivência do filho', () => {
  test('SEC-06 — o filho se encerra sozinho com o código 124 se ficar preso além do prazo (aqui: entrada nunca fechada, tempo interno de 1 s ⇒ ~4 s)', { timeout: 30000 }, async () => {
    const worker = path.join(SRC, 'workers', 'imagem-processador.worker.js');
    if (!fs.existsSync(worker)) throw new Error('módulo ainda não implementado: src/workers/imagem-processador.worker.js');
    const { parametrosDoProcessamento, montarExecucaoDoFilho } = require('../../src/services/imagem-processador.service');
    const execucao = montarExecucaoDoFilho({ parametros: parametrosDoProcessamento(undefined, { timeoutSegundos: 1 }) });
    const t0 = Date.now();
    const filho = childProcess.spawn(execucao.comando, execucao.argumentos, execucao.opcoes);
    filho.stdin.on('error', () => {});
    const fechou = new Promise((resolve) => { filho.once('close', (codigo, sinal) => resolve({ codigo, sinal })); });
    let limite;
    const estourou = new Promise((resolve) => { limite = setTimeout(() => resolve({ estourou: true }), 12000); });
    let resultado;
    try {
      resultado = await Promise.race([fechou, estourou]);
    } finally {
      // Limpeza: se o relógio de sobrevivência falhar, o filho deste teste (e só ele, pela referência que o teste criou) não pode segurar o processo do arquivo.
      clearTimeout(limite);
      if (filho.exitCode === null && filho.signalCode === null) filho.kill('SIGKILL');
    }
    const gasto = Date.now() - t0;
    assert.deepEqual(resultado, { codigo: 124, sinal: null });
    assert.ok(gasto >= 3500 && gasto < 12000, `encerrou em ${gasto} ms`);
  });
});
