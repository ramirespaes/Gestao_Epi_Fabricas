'use strict';

const { createHash } = require('node:crypto');
const path = require('node:path');
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const imagemEmpresaRepo = require('../../src/repositories/imagem-empresa.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const { criarUploadDeImagens } = require('../../src/services/imagem-material-upload.service');
const { criarSemaforo } = require('../../src/utils/semaforo');
const { criarArmazenamentoMemoriaFalso } = require('../storage/helpers/armazenamento-memoria-falso');
const { png: pngFalso } = require('../helpers/imagens-validas');
const F = require('../helpers/imagens-reais');

/**
 * Biblioteca de Imagens, Unidade 5C-4 — o ENVIO COMPLETO com o PROCESSADOR REAL (processo filho + sharp) no lugar do falso: o serviço de envio da 5C-2 continua o mesmo
 * (deduplicação, trava da empresa, cota, gravação atômica, auditoria); o que muda é quem decodifica. Sem PostgreSQL (repositórios simulados) e sem disco (armazenamento
 * em memória). Prova: o conjunto gravado é o do contrato; toda recusa e toda falha acontecem ANTES de qualquer conexão, trava ou arquivo (nada parcial, nada de registro
 * indevido); fila, espera e tempo máximo viram 503/422 com os códigos combinados; o filho nunca passa do limite de simultâneos.
 */

const carregar = (caminho, trecho) => {
  try { return require(caminho); } catch (erro) {
    if (erro.code === 'MODULE_NOT_FOUND' && String(erro.message).includes(trecho)) throw new Error(`módulo ainda não implementado: ${caminho}`);
    throw erro;
  }
};
const S = () => carregar('../../src/services/imagem-processador.service', 'imagem-processador.service');
const teste = (nome, fn) => test(nome, { timeout: 90000 }, fn);
const FILHOS = path.join(__dirname, '..', 'helpers', 'filhos');
const CONTEXTO = Object.freeze({ empresaId: 3, atorId: 9, nome: 'Luva enviada', ip: '203.0.113.10', dispositivo: 'Navegador de teste' });
const sha = (b) => createHash('sha256').update(b).digest('hex');
const dormir = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const proximosTicks = async (n = 6) => { for (let i = 0; i < n; i += 1) await new Promise((resolve) => { setImmediate(resolve); }); };
async function esperarAte(condicao, ms = 5000) { const limite = Date.now() + ms; while (Date.now() < limite) { if (await condicao()) return true; await dormir(10); } return false; }
const comLimite = (promessa, ms, valor) => { let id; return Promise.race([promessa, new Promise((resolve) => { id = setTimeout(() => resolve(valor), ms); })]).finally(() => clearTimeout(id)); };

function montar(t, { processador, semaforo, consumo = { imagens: 0, bytes: 0, bytesArmazenados: 0 } } = {}) {
  const eventos = [];
  const linhas = [];
  const cliente = { query: async (sql) => { eventos.push(`sql:${String(sql).trim().split(/\s+/)[0].toUpperCase()}`); return { rows: [] }; }, release: () => { eventos.push('release'); } };
  const pool = { connect: async () => { eventos.push('connect'); return cliente; } };
  t.mock.method(imagemEmpresaRepo, 'travarBiblioteca', async (_x, empresaId) => { eventos.push(`travar:${empresaId}`); });
  t.mock.method(imagemEmpresaRepo, 'buscarPorSha256', async (_x, empresaId, hash) => { eventos.push('buscar'); return linhas.find((l) => l.empresaId === empresaId && l.sha256 === hash) ?? null; });
  t.mock.method(imagemEmpresaRepo, 'somarConsumo', async () => { eventos.push('somar'); return consumo; });
  t.mock.method(imagemEmpresaRepo, 'inserir', async (_x, dados) => { eventos.push('inserir'); const linha = { id: String(9000 + linhas.length + 1), versao: 1, estado: 'ATIVA', ...dados }; linhas.push(linha); return linha; });
  t.mock.method(auditoriaRepo, 'registrar', async () => { eventos.push('auditar'); });
  const memoria = criarArmazenamentoMemoriaFalso();
  const armazenamento = { async gravar(chave, fonte, opcoes) { eventos.push(`gravar:${chave.split('/').pop()}`); return memoria.gravar(chave, fonte, opcoes); } };
  const envio = criarUploadDeImagens({ armazenamento, processador, ...(semaforo ? { semaforo } : {}) });
  return { eventos, linhas, pool, memoria, envio };
}
const recusa = (status, codigo) => (falha) => {
  assert.equal(falha.status, status, `${falha.codigo}: ${falha.message}`);
  assert.equal(falha.codigo, codigo);
  assert.equal(typeof falha.message, 'string');
  return true;
};

describe('envio com o processador real — o conjunto gravado', () => {
  teste('UPR-01 — PNG válido: três arquivos nas chaves do contrato, o registro coerente com o que foi gravado, SHA-256 do ENVIO como chave de deduplicação e a linha do tempo de sempre', async (t) => {
    const processador = S().criarProcessadorDeImagens();
    const { eventos, linhas, pool, memoria, envio } = montar(t, { processador });
    const bytes = await F.png(640, 480);
    const r = await envio.enviar(pool, { ...CONTEXTO, bytes });
    assert.equal(r.reaproveitada, false);
    assert.deepEqual(eventos, ['connect', 'sql:BEGIN', 'travar:3', 'buscar', 'somar', 'gravar:mestre.png', 'gravar:exibicao.webp', 'gravar:miniatura.webp', 'inserir', 'auditar', 'sql:COMMIT', 'release']);
    const l = linhas[0];
    assert.deepEqual([l.empresaId, l.formato, l.largura, l.altura, l.sha256], [3, 'PNG', 1024, 1024, sha(bytes)]);
    const base = `3/${sha(bytes)}`;
    const ler = async (chave) => Buffer.concat(await (await memoria.abrir(chave)).toArray());
    const conteudos = { mestre: await ler(`${base}/mestre.png`), exibicao: await ler(`${base}/exibicao.webp`), miniatura: await ler(`${base}/miniatura.webp`) };
    assert.deepEqual([l.bytesMestre, l.bytesExibicao, l.bytesMiniatura], [conteudos.mestre.length, conteudos.exibicao.length, conteudos.miniatura.length]);
    assert.deepEqual([l.sha256Mestre, l.sha256Exibicao, l.sha256Miniatura], [sha(conteudos.mestre), sha(conteudos.exibicao), sha(conteudos.miniatura)]);
    const [mm, me, mi] = await Promise.all([F.metadados(conteudos.mestre), F.metadados(conteudos.exibicao), F.metadados(conteudos.miniatura)]);
    assert.deepEqual([mm.format, mm.width, mm.height, me.format, me.width, me.height, mi.format, mi.width, mi.height], ['png', 1024, 1024, 'webp', 640, 640, 'webp', 320, 320]);
    assert.deepEqual(processador.ativos(), []);
  });

  teste('UPR-02 — o mesmo envio de novo: o conjunto é reprocessado (a decodificação vem antes da deduplicação), mas NADA novo é gravado nem registrado — devolve a imagem existente', async (t) => {
    const processador = S().criarProcessadorDeImagens();
    const { eventos, linhas, pool, memoria, envio } = montar(t, { processador });
    const bytes = await F.jpeg(500, 400);
    const primeiro = await envio.enviar(pool, { ...CONTEXTO, bytes });
    const antes = eventos.length;
    const segundo = await envio.enviar(pool, { ...CONTEXTO, bytes: Buffer.from(bytes) });
    assert.deepEqual([segundo.reaproveitada, segundo.imagem.id], [true, primeiro.imagem.id]);
    assert.deepEqual(eventos.slice(antes).filter((e) => e.startsWith('gravar:') || e === 'inserir' || e === 'auditar'), []);
    assert.equal(linhas.length, 1);
    assert.equal((await memoria.listar('3')).length, 3);
  });
});

describe('envio com o processador real — recusas e falhas acontecem antes de tudo', () => {
  teste('UPR-03 — formato, animação, dimensões, arquivo cortado e poliglota perigoso viram a recusa pública combinada, sem conexão, trava, arquivo nem registro', async (t) => {
    const { eventos, pool, envio } = montar(t, { processador: S().criarProcessadorDeImagens() });
    const casos = [
      [F.svg(), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO'], [await F.gif(), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO'], [F.apng(await F.png(400, 320)), 415, 'IMAGEM_ANIMADA_NAO_SUPORTADA'],
      [await F.webpAnimado(320), 415, 'IMAGEM_ANIMADA_NAO_SUPORTADA'], [await F.png(319, 400), 400, 'IMAGEM_DIMENSOES_INVALIDAS'], [await F.pngDePixelsEnormes(3000, 2800), 400, 'IMAGEM_DIMENSOES_INVALIDAS'],
      [F.truncar(await F.png(400, 320, { padrao: 'ruido' }), 0.5), 400, 'IMAGEM_INVALIDA'], [F.pngComCrcCorrompido(await F.png(400, 320, { padrao: 'ruido' })), 400, 'IMAGEM_INVALIDA'],
      [F.jpegCortadoComEoi(await F.jpeg(400, 320, { padrao: 'ruido' })), 400, 'IMAGEM_INVALIDA'], [Buffer.concat([await F.png(400, 320), F.zip()]), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO'],
    ];
    for (const [bytes, status, codigo] of casos) await assert.rejects(envio.enviar(pool, { ...CONTEXTO, bytes }), recusa(status, codigo), codigo);
    assert.deepEqual(eventos, []);
  });

  teste('UPR-04 — a mensagem pública nunca repete o envio (VAL-08): nem o nome, nem os bytes, nem texto do libvips', async (t) => {
    const { pool, envio } = montar(t, { processador: S().criarProcessadorDeImagens() });
    const marcador = 'MARCADOR-SECRETO-c0ffee';
    for (const bytes of [Buffer.from(marcador), Buffer.concat([await F.png(400, 320), Buffer.from(`<script>${marcador}</script>`)]), F.pngComCrcCorrompido(await F.png(400, 320, { padrao: 'ruido' }))]) {
      const falha = await envio.enviar(pool, { ...CONTEXTO, nome: `nome-${marcador}`, bytes }).then(() => null, (e) => e);
      assert.ok(falha && falha.status >= 400 && falha.status < 500);
      assert.ok(!String(falha.message).includes(marcador) && !/vips|libpng|libjpeg|premature|corrupt jpeg/i.test(String(falha.message)));
      assert.ok(!JSON.stringify(falha.corpoResposta()).includes(marcador));
    }
  });

  teste('UPR-05 — tempo máximo estourado: 422 IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO, sem conexão, trava, arquivo nem registro, e o filho morreu', async (t) => {
    const processador = S().criarProcessadorDeImagens({ caminhoDoFilho: path.join(FILHOS, 'travado.js'), prazoExternoMs: 300 });
    const { eventos, pool, envio } = montar(t, { processador });
    await assert.rejects(envio.enviar(pool, { ...CONTEXTO, bytes: await F.png(400, 320) }), recusa(422, 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO'));
    assert.deepEqual(eventos, []);
    assert.deepEqual(processador.ativos(), []);
  });

  teste('UPR-06 — saída acima dos tetos: 422 IMAGEM_SAIDA_EXCEDE_LIMITE, sem gravar nada', async (t) => {
    const processador = S().criarProcessadorDeImagens({ parametros: S().parametrosDoProcessamento(undefined, { mestre: { bytesMax: 2000 } }) });
    const { eventos, pool, envio } = montar(t, { processador });
    await assert.rejects(envio.enviar(pool, { ...CONTEXTO, bytes: await F.png(500, 400, { padrao: 'ruido' }) }), recusa(422, 'IMAGEM_SAIDA_EXCEDE_LIMITE'));
    assert.deepEqual(eventos, []);
  });

  teste('UPR-07 — falhas do próprio filho: sem o sharp = 503 IMAGENS_INDISPONIVEL; morte por sinal ou saída ruim = 500 ERRO_INTERNO genérico; nenhum caso toca o banco ou o armazenamento', async (t) => {
    const bytes = await F.png(400, 320);
    for (const [script, status, codigo] of [['sem-sharp.js', 503, 'IMAGENS_INDISPONIVEL'], ['morre-por-sinal.js', 500, 'ERRO_INTERNO'], ['sai-com-codigo.js', 500, 'ERRO_INTERNO'], ['lixo.js', 500, 'ERRO_INTERNO']]) {
      const processador = S().criarProcessadorDeImagens({ caminhoDoFilho: path.join(FILHOS, script), prazoExternoMs: 20000 });
      const { eventos, pool, envio } = montar(t, { processador });
      const falha = await envio.enviar(pool, { ...CONTEXTO, bytes }).then(() => null, (e) => e);
      assert.equal(falha?.status, status, script);
      assert.equal(falha?.codigo, codigo, script);
      assert.deepEqual(eventos, [], script);
      assert.ok(!/GIMG|SIGKILL|signal|código de saída/i.test(String(falha.message)), script);
    }
  });
});

describe('envio com o processador real — fila, espera e simultaneidade', () => {
  const SAIDA = () => ({ formato: 'PNG', largura: 1024, altura: 1024, mestre: Buffer.alloc(100, 1), exibicao: Buffer.alloc(50, 2), miniatura: Buffer.alloc(20, 3) });
  function processadorComPortao() {
    const portoes = [];
    let andamento = 0;
    let maximo = 0;
    return {
      portoes, maximo: () => maximo, andamento: () => andamento,
      async processar() {
        andamento += 1; maximo = Math.max(maximo, andamento);
        await new Promise((abrir) => { portoes.push(abrir); });
        andamento -= 1;
        return SAIDA();
      },
    };
  }

  teste('UPR-08 — saturação com a CONFIGURAÇÃO PADRÃO do serviço: 2 em processamento, 8 esperando, a 11ª recusada NA HORA com 503 IMAGENS_OCUPADO e Retry-After de 5 s; as 10 aceitas terminam', async (t) => {
    const gate = processadorComPortao();
    const { eventos, pool, envio } = montar(t, { processador: gate });
    const resultados = [];
    try {
      for (let i = 0; i < 11; i += 1) resultados.push(envio.enviar(pool, { ...CONTEXTO, nome: `n${i}`, bytes: pngFalso(320 + i, 320) }).then((r) => ({ r }), (e) => ({ e })));
      await proximosTicks();
      assert.equal(gate.andamento(), 2, 'só 2 decodificando');
      const recusada = await comLimite(resultados[10], 3000, { semRecusa: true });
      assert.equal(recusada.semRecusa, undefined, 'a 11ª tarefa deveria ter sido recusada na hora');
      assert.equal(recusada.e?.status, 503);
      assert.equal(recusada.e?.codigo, 'IMAGENS_OCUPADO');
      assert.deepEqual(recusada.e?.headers, { 'Retry-After': '5' });
      assert.equal(eventos.includes('connect'), false, 'nenhuma conexão enquanto ninguém terminou a decodificação');
      for (let rodada = 0; rodada < 10; rodada += 1) {
        assert.ok(await esperarAte(() => gate.portoes.length > rodada), `a decodificação ${rodada + 1} começou`);
        gate.portoes[rodada]();
        await proximosTicks(10);
      }
      const todos = await Promise.all(resultados.slice(0, 10));
      assert.ok(todos.every((x) => x.r && x.r.reaproveitada === false), JSON.stringify(todos.filter((x) => x.e).map((x) => x.e.codigo)));
      assert.equal(gate.maximo(), 2, 'nunca passou de 2 ao mesmo tempo');
    } finally {
      // Limpeza: as decodificações deste teste são só portões em memória; se o teste falhar no meio, abre todos para a fila esvaziar e nenhuma promessa do teste fica presa.
      for (let volta = 0; volta < 50 && (volta === 0 || gate.andamento() > 0); volta += 1) { gate.portoes.forEach((abrir) => abrir()); await proximosTicks(4); }
      await comLimite(Promise.allSettled(resultados), 3000, null);
    }
  });

  teste('UPR-09 — espera máxima: quem aguarda além do prazo recebe 503 IMAGENS_OCUPADO com Retry-After de 10 s, sem conexão, e quem estava rodando termina normalmente', async (t) => {
    const gate = processadorComPortao();
    const semaforo = criarSemaforo(1, { filaMaxima: 8, esperaMaximaMs: 80 });
    const { eventos, pool, envio } = montar(t, { processador: gate, semaforo });
    const primeiro = envio.enviar(pool, { ...CONTEXTO, nome: 'a', bytes: pngFalso(330, 320) });
    await proximosTicks();
    const t0 = Date.now();
    const segundo = await envio.enviar(pool, { ...CONTEXTO, nome: 'b', bytes: pngFalso(331, 320) }).then(() => null, (e) => e);
    assert.equal(segundo?.status, 503);
    assert.equal(segundo?.codigo, 'IMAGENS_OCUPADO');
    assert.deepEqual(segundo?.headers, { 'Retry-After': '10' });
    assert.ok(Date.now() - t0 >= 70 && Date.now() - t0 < 2000);
    assert.equal(eventos.includes('connect'), false);
    gate.portoes[0]();
    assert.equal((await primeiro).reaproveitada, false);
    assert.deepEqual([semaforo.emUso, semaforo.esperando], [0, 0]);
  });

  teste('UPR-10 — com o filho REAL e o semáforo de 2: 6 envios simultâneos terminam certos, nunca há mais de 2 filhos vivos, e depois não sobra filho, vaga ocupada nem espera', async (t) => {
    const processador = S().criarProcessadorDeImagens();
    const semaforo = criarSemaforo(2, { filaMaxima: 8, esperaMaximaMs: 10000 });
    const { linhas, pool, envio } = montar(t, { processador, semaforo });
    const entradas = [await F.png(500, 400), await F.jpeg(510, 400), await F.webp(520, 400), await F.png(530, 400), await F.jpeg(540, 400), await F.webp(550, 400)];
    let maximo = 0;
    const sondar = setInterval(() => { maximo = Math.max(maximo, processador.ativos().length); }, 3);
    try {
      const resultados = await Promise.all(entradas.map((bytes, i) => envio.enviar(pool, { ...CONTEXTO, nome: `img${i}`, bytes })));
      assert.ok(resultados.every((r) => r.reaproveitada === false));
    } finally { clearInterval(sondar); }
    assert.ok(maximo >= 1 && maximo <= 2, `filhos vivos ao mesmo tempo: ${maximo}`);
    assert.equal(linhas.length, 6);
    assert.deepEqual(processador.ativos(), []);
    assert.deepEqual([semaforo.emUso, semaforo.esperando], [0, 0]);
  });

  teste('UPR-11 — uma falha no meio da fila não trava ninguém: a vaga volta, o seguinte processa, e nada fica ocupado', async (t) => {
    const processador = S().criarProcessadorDeImagens();
    const semaforo = criarSemaforo(1, { filaMaxima: 8, esperaMaximaMs: 10000 });
    const { linhas, pool, envio } = montar(t, { processador, semaforo });
    const ruim = F.pngComCrcCorrompido(await F.png(400, 320, { padrao: 'ruido' }));
    const bom = await F.png(450, 320);
    const saidas = await Promise.all([envio.enviar(pool, { ...CONTEXTO, bytes: ruim }).then(() => 'ok', (e) => e.codigo), envio.enviar(pool, { ...CONTEXTO, bytes: bom }).then(() => 'ok', (e) => e.codigo)]);
    assert.deepEqual(saidas, ['IMAGEM_INVALIDA', 'ok']);
    assert.equal(linhas.length, 1);
    assert.deepEqual([semaforo.emUso, semaforo.esperando, processador.ativos().length], [0, 0, 0]);
  });

  teste('UPR-12 — na configuração padrão quem espera mais de 10 s na fila é recusado com 503 IMAGENS_OCUPADO e Retry-After de 10 s (relógio simulado: nem um instante antes)', async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const gate = processadorComPortao();
    const { eventos, pool, envio } = montar(t, { processador: gate });
    const primeiros = [envio.enviar(pool, { ...CONTEXTO, nome: 'a', bytes: pngFalso(340, 320) }), envio.enviar(pool, { ...CONTEXTO, nome: 'b', bytes: pngFalso(341, 320) })];
    const terceiro = envio.enviar(pool, { ...CONTEXTO, nome: 'c', bytes: pngFalso(342, 320) }).then(() => null, (e) => e);
    await proximosTicks();
    assert.equal(gate.andamento(), 2);
    t.mock.timers.tick(9999);
    await proximosTicks();
    assert.equal(eventos.includes('connect'), false);
    t.mock.timers.tick(1);
    const erro = await terceiro;
    assert.equal(erro?.status, 503);
    assert.equal(erro?.codigo, 'IMAGENS_OCUPADO');
    assert.deepEqual(erro?.headers, { 'Retry-After': '10' });
    gate.portoes.forEach((abrir) => abrir());
    await Promise.all(primeiros);
  });
});
