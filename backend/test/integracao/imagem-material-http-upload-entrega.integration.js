'use strict';

// Limites do ambiente de teste, lidos na carga: ANTES de carregar qualquer módulo de src/ (cada arquivo de teste roda em processo próprio). Taxas no teto, para que a
// bateria inteira (um mesmo MASTER enviando dezenas de vezes por minuto) nunca esbarre no 429, que tem teste próprio na camada de rotas (UPL-R16 e UPL-R17); cota de
// bytes no piso (10 MiB), para o UPL-08 chegar a ela com UMA linha semeada.
process.env.IMAGENS_ENVIOS_POR_MINUTO_USUARIO = '60';
process.env.IMAGENS_ENVIOS_POR_HORA_EMPRESA = '1000';
process.env.IMAGENS_COTA_MIB = '10';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const zlib = require('node:zlib');
const request = require('supertest');
const { montarAmbienteHttpImagens } = require('./helpers/imagem-material-http');
const { semearEmpresa, semearPadrao, cabecalhosComparaveis } = require('./helpers/imagem-material-entrega');
const { CABECALHO } = require('./helpers/ambiente-http-12d2');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarProcessadorFalso } = require('../helpers/processador-imagem-falso');
const { sha256Hex } = require('../helpers/imagens-ficticias');
const { chaveDe } = require('../../src/storage/armazenamento-imagens');
const imagemEmpresaRepo = require('../../src/repositories/imagem-empresa.repository');

/**
 * Biblioteca de Imagens — contratos HTTP do ENVIO (upload) e da ENTREGA de arquivos, contra PostgreSQL real (schema temporário exclusivo com todas as migrations) e
 * armazenamento real em diretório temporário exclusivo. Este arquivo é ESPECIFICAÇÃO EXECUTÁVEL.
 *
 * Unidade 5C-1 (RED do backend, só testes): UPL-01 a UPL-05 foram REATIVADOS (sem `skip`) e ajustados, e UPL-06 a UPL-09 foram acrescentados para caracterizar o que
 * as camadas simuladas (test/routes e test/services do envio) não alcançam: gravação coerente (linha + três arquivos + entrega), concorrência no banco, cota e a
 * independência entre decodificar e a trava da biblioteca. O processador de imagem é o FALSO (test/helpers/processador-imagem-falso.js): nenhuma biblioteca de
 * imagem entra antes da 5C-3. ENT-01 e ENT-02 (entrega, Unidade 5A-1) seguem ativos e não mudaram.
 *
 * ATENÇÃO: estes testes exigem PostgreSQL real e NÃO foram executados na 5C-1 (a rodada proibia banco real, upload real e Git). Foram escritos contra os contratos
 * verificados nas fontes (serviço de registro, repositório, armazenamento e helpers) e conferidos apenas por análise de sintaxe. Falharão por funcionalidade ausente
 * até a 5C-2; a primeira execução com banco deve ser autorizada à parte.
 *
 *   POST /api/imagens-material/empresa?nome=   (materials.criar)  corpo BINÁRIO image/png|jpeg|webp ≤ 2 MiB, lado 320–4096, ≤ 8 Mpx
 *        → 201 { status:'ok', imagem:{ origem:'EMPRESA', id, nome, formato, largura, altura, versao:1, estado:'ATIVA' }, reaproveitada:false }
 *        → 200 reaproveitada:true (mesmo conteúdo na empresa) · 415 TIPO_CONTEUDO_NAO_SUPORTADO (JSON, texto…) · 415 IMAGEM_FORMATO_NAO_SUPORTADO (GIF… pelos bytes)
 *        → 413 PAYLOAD_MUITO_GRANDE · 400 IMAGEM_INVALIDA (corrompida) · 400 IMAGEM_DIMENSOES_INVALIDAS · 409 IMAGEM_COTA_EXCEDIDA · 429 taxa.
 *        Sessão e permissão ANTES de ler o corpo. Nada é gravado em nenhuma recusa (linha, arquivo ou auditoria).
 *   GET  /api/imagens-material/:origem/:id/:variante?v=  (materials.visualizar; origem padrao|empresa; variante miniatura|exibicao) — ENT-01, ENT-02 (Unidade 5A-1)
 *        → 200 image/webp, X-Content-Type-Options: nosniff, Cache-Control: private (imutável só com `v` = versão atual), ETag forte; 404 uniforme (inexistente,
 *          outra empresa, inativa, variante desconhecida, arquivo ausente ou adulterado). O detalhe da entrega está em imagem-material-http-entrega.integration.js.
 *   A rota do tablet (catálogo do Totem) e a importação das 30 imagens padrão são contratos de outras unidades.
 *
 * Costuras previstas (a confirmar no GREEN da 5C-2; os testes fixam só o mínimo): `criarImagemMaterialController({ pool, armazenamento, processador, … })` compõe o
 * serviço de envio; o falso entra por `montarAmbienteHttpImagens({ comArmazenamento: true, processador })` (helper, acréscimo aditivo).
 * UPL-09 não impõe COMO o envio evita segurar a trava durante a decodificação; impõe que uma recusa por conteúdo não dependa dela.
 */

const BASE = '/api/imagens-material';
const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;

// PNG mínimo válido (RGBA, sem compressão de filtro) só para o contrato; nunca é uma das 30 imagens reais.
function png(largura, altura) {
  const crcTabela = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (buf) => { let c = 0xffffffff; for (const b of buf) c = crcTabela[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const pedaco = (tipo, dados) => { const len = Buffer.alloc(4); len.writeUInt32BE(dados.length); const td = Buffer.concat([Buffer.from(tipo, 'ascii'), dados]); const c = Buffer.alloc(4); c.writeUInt32BE(crc(td)); return Buffer.concat([len, td, c]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(largura, 0); ihdr.writeUInt32BE(altura, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const linhas = Buffer.alloc((largura * 4 + 1) * altura);
  for (let y = 0; y < altura; y += 1) { const base = y * (largura * 4 + 1); linhas[base] = 0; for (let x = 0; x < largura; x += 1) { const i = base + 1 + x * 4; linhas[i] = (x * 7) & 255; linhas[i + 1] = (y * 3) & 255; linhas[i + 2] = 90; linhas[i + 3] = 255; } }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), pedaco('IHDR', ihdr), pedaco('IDAT', zlib.deflateSync(linhas)), pedaco('IEND', Buffer.alloc(0))]);
}

describe('Biblioteca de Imagens — upload (Unidade 5C-1, RED: o envio ainda não existe) e entrega de arquivos por HTTP', () => {
  let a;
  let app;
  let master;
  let deB;
  let processador;

  // Armazenamento temporário exclusivo (criado e removido pelo ambiente) e processador FALSO injetado. O `aguardar` dá alguns milissegundos de decodificação
  // simulada, para que envios simultâneos realmente se sobreponham. Se o módulo de rotas não existir, o `before` não lança (cada teste exige o app).
  before(async () => {
    processador = criarProcessadorFalso({ aguardar: () => new Promise((resolver) => { setTimeout(resolver, 30); }) });
    a = await montarAmbienteHttpImagens({ comArmazenamento: true, processador });
    if (a.rotasDeImagem === null) return;
    app = a.appDeEntrega();
    master = (metodo, url) => request(app)[metodo](url).set(CABECALHO, String(a.d.master));
    deB = (metodo, url) => request(app)[metodo](url).set(CABECALHO, String(a.d.masterB));
  });
  after(async () => { if (a) await a.encerrar(); });

  const exigirApp = () => { if (!app) { exigirModulo('src/routes/imagem-material.routes'); exigirModulo('src/controllers/imagem-material.controller'); } };
  // Contrato FUTURO: enquanto o upload binário não existir, o POST de uma imagem não chega a nenhuma rota (a política de conteúdo do /api só aceita
  // JSON em POST: 415 TIPO_CONTEUDO_NAO_SUPORTADO) ou cai no 404. O teste diz isso explicitamente, em vez de falhar adiante por TypeError ou EPIPE.
  const exigirUploadImplementado = (r) => {
    if (r.status === 404 || (r.status === 415 && r.body?.codigo === 'TIPO_CONTEUDO_NAO_SUPORTADO')) {
      assert.fail(`contrato futuro: o upload binário (POST ${BASE}/empresa) ainda não existe — o POST de imagem respondeu ${r.status} ${r.body?.codigo}`);
    }
    return r;
  };
  const enviar = async (bytes, { nome = 'Luva enviada', tipo = 'image/png', quem = master } = {}) => {
    exigirApp();
    const r = await quem('post', `${BASE}/empresa?nome=${encodeURIComponent(nome)}`).set('Content-Type', tipo).send(bytes);
    return tipo.startsWith('image/') ? exigirUploadImplementado(r) : r;
  };
  const arquivosDa = (empresaId) => a.armazenamento.listar(String(empresaId));
  const lerFluxo = async (fluxo) => { const partes = []; for await (const parte of fluxo) partes.push(parte); return Buffer.concat(partes); };
  // Tudo o que um envio bem-sucedido deixaria para trás numa empresa: linhas, arquivos e auditorias de importação. Uma recusa não pode alterar nenhum dos três.
  const fotografia = async (empresaId) => ({
    linhas: await a.contagem('imagens_empresa', 'empresa_id = $1', [empresaId]),
    arquivos: await arquivosDa(empresaId),
    auditorias: await a.contagem('logs_auditoria', "acao = 'IMAGEM_MATERIAL_IMPORTADA' AND empresa_id = $1", [empresaId]),
  });

  test('UPL-01 — PNG 320×320 válido → 201 com a imagem registrada (formato, medidas, versão 1, ATIVA, id em texto) e reaproveitada=false; sem campos internos', async () => {
    const r = await enviar(png(320, 320));
    assert.equal(r.status, 201, aviso(r));
    assert.deepEqual(Object.keys(r.body).sort(), ['imagem', 'reaproveitada', 'status']);
    assert.deepEqual([r.body.reaproveitada, r.body.imagem.origem, r.body.imagem.formato, r.body.imagem.largura, r.body.imagem.altura, r.body.imagem.versao, r.body.imagem.estado, r.body.imagem.nome], [false, 'EMPRESA', 'PNG', 320, 320, 1, 'ATIVA', 'Luva enviada']);
    assert.equal(typeof r.body.imagem.id, 'string');
    a.semCamposInternos(r.body, 'UPL-01');
  });

  test('UPL-02 — o mesmo conteúdo enviado de novo na mesma empresa → 200 reaproveitada=true com o MESMO id, sem nova linha e sem nova auditoria; em outra empresa é outra imagem, DA outra empresa', async () => {
    const bytes = png(321, 320);
    const r1 = await enviar(bytes);
    const linhas = await a.contagem('imagens_empresa');
    const r2 = await enviar(bytes, { nome: 'Outro nome' });
    assert.deepEqual([r1.status, r2.status, r2.body.reaproveitada, r2.body.imagem.id], [201, 200, true, r1.body.imagem.id], aviso(r2));
    assert.equal(r2.body.imagem.nome, 'Luva enviada', 'reaproveitar devolve a imagem existente e não a renomeia');
    assert.equal(await a.contagem('imagens_empresa'), linhas, 'reaproveitar não cria linha');
    assert.equal((await a.auditorias('IMAGEM_MATERIAL_IMPORTADA', r1.body.imagem.id)).length, 1, 'reaproveitar não audita de novo');
    const r3 = await enviar(bytes, { quem: deB });
    assert.deepEqual([r3.status, r3.body.reaproveitada], [201, false], aviso(r3));
    assert.notEqual(r3.body.imagem.id, r1.body.imagem.id);
    assert.equal(Number((await a.linhaDaImagem(r3.body.imagem.id)).empresa_id), Number(a.d.empresaB), 'a imagem da outra empresa pertence a ela');
    assert.equal(Number((await a.linhaDaImagem(r1.body.imagem.id)).empresa_id), Number(a.d.empresaA));
  });

  test('UPL-03 — sessão e permissão ANTES do corpo: sem sessão 401; só visualizar 403; nada é gravado (nem linha, nem arquivo, nem auditoria)', async () => {
    exigirApp();
    const antes = await fotografia(a.d.empresaA);
    const semSessao = exigirUploadImplementado(await request(app).post(`${BASE}/empresa?nome=x`).set('Content-Type', 'image/png').send(png(320, 320)));
    assert.equal(semSessao.status, 401, aviso(semSessao));
    const soVisualizar = await a.usuarioCom(a.d.empresaA, { materials: ['visualizar'] });
    const r = await request(app).post(`${BASE}/empresa?nome=x`).set(CABECALHO, String(soVisualizar)).set('Content-Type', 'image/png').send(png(320, 320));
    assert.equal(r.status, 403, aviso(r));
    assert.deepEqual(await fotografia(a.d.empresaA), antes);
  });

  test('UPL-04 — recusas: JSON e texto 415; GIF (pelos bytes, com image/gif ou image/png) 415 IMAGEM_FORMATO_NAO_SUPORTADO; PNG truncado 400 IMAGEM_INVALIDA; 200×200 400 IMAGEM_DIMENSOES_INVALIDAS; acima de 2 MiB 413; nome ausente ou acima de 100 → 400; nada é gravado', async () => {
    exigirApp();
    await enviar(png(325, 320), { nome: 'sonda UPL04' }); // falha explicitamente enquanto o upload não existir; depois, é uma imagem válida a mais
    const antes = await fotografia(a.d.empresaA);
    const casos = [
      [await master('post', `${BASE}/empresa?nome=x`).send({ a: 1 }), 415, 'TIPO_CONTEUDO_NAO_SUPORTADO'],
      [await enviar(Buffer.from('texto'), { tipo: 'text/plain' }), 415, 'TIPO_CONTEUDO_NAO_SUPORTADO'],
      [await enviar(Buffer.from('GIF89a' + '\0'.repeat(40)), { tipo: 'image/gif' }), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO'],
      [await enviar(Buffer.from('GIF89a' + '\0'.repeat(40)), { tipo: 'image/png' }), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO'],
      [await enviar(png(320, 320).subarray(0, 200)), 400, 'IMAGEM_INVALIDA'],
      [await enviar(png(200, 200)), 400, 'IMAGEM_DIMENSOES_INVALIDAS'],
      [await enviar(Buffer.alloc(2 * 1024 * 1024 + 1, 1)), 413, 'PAYLOAD_MUITO_GRANDE'],
      [await master('post', `${BASE}/empresa`).set('Content-Type', 'image/png').send(png(320, 320)), 400, 'VALIDACAO'],
      [await enviar(png(320, 320), { nome: 'x'.repeat(101) }), 400, 'VALIDACAO'],
    ];
    for (const [r, status, codigo] of casos) assert.deepEqual([r.status, r.body.codigo], [status, codigo], aviso(r));
    assert.deepEqual(await fotografia(a.d.empresaA), antes, 'nenhuma recusa deixa linha, arquivo ou auditoria');
  });

  test('UPL-05 — a importação deixa UMA auditoria IMAGEM_MATERIAL_IMPORTADA só com id, formato e bytes (a soma das três versões gravadas)', async () => {
    const bytes = png(322, 320);
    const r = await enviar(bytes);
    assert.equal(r.status, 201, aviso(r));
    const logs = await a.auditorias('IMAGEM_MATERIAL_IMPORTADA', r.body.imagem.id);
    assert.equal(logs.length, 1);
    assert.deepEqual(Object.keys(logs[0].contexto).sort(), ['bytes', 'formato', 'imagemId']);
    const esperado = processador.resultadoEsperado(bytes);
    assert.equal(logs[0].contexto.formato, 'PNG');
    assert.equal(logs[0].contexto.bytes, esperado.mestre.length + esperado.exibicao.length + esperado.miniatura.length);
  });

  test('UPL-06 — o que o envio grava: a linha coerente com o processamento, os TRÊS arquivos nas chaves previstas com exatamente os bytes do processador, e a entrega devolve esses mesmos bytes', async () => {
    const bytes = png(330, 320);
    const sha256 = sha256Hex(bytes);
    const r = await enviar(bytes, { nome: 'Gravação UPL06' });
    assert.equal(r.status, 201, aviso(r));
    const esperado = processador.resultadoEsperado(bytes);
    const linha = (await a.q('SELECT * FROM imagens_empresa WHERE id = $1', [r.body.imagem.id])).rows[0];
    assert.deepEqual(
      [Number(linha.empresa_id), Number(linha.criado_por), linha.sha256, linha.sha256_mestre, linha.sha256_exibicao, linha.sha256_miniatura, linha.formato, linha.largura, linha.altura,
        linha.bytes_mestre, linha.bytes_exibicao, linha.bytes_miniatura, linha.estado, Number(linha.versao)],
      [Number(a.d.empresaA), Number(a.d.master), sha256, sha256Hex(esperado.mestre), sha256Hex(esperado.exibicao), sha256Hex(esperado.miniatura), 'PNG', 330, 320,
        esperado.mestre.length, esperado.exibicao.length, esperado.miniatura.length, 'ATIVA', 1],
      'a linha guarda o SHA-256 do ENVIO, o de cada versão gravada e os tamanhos reais',
    );
    const chaves = {
      mestre: chaveDe({ escopo: 'EMPRESA', empresaId: a.d.empresaA, sha256, variante: 'mestre', formato: 'PNG' }),
      exibicao: chaveDe({ escopo: 'EMPRESA', empresaId: a.d.empresaA, sha256, variante: 'exibicao', formato: 'WEBP' }),
      miniatura: chaveDe({ escopo: 'EMPRESA', empresaId: a.d.empresaA, sha256, variante: 'miniatura', formato: 'WEBP' }),
    };
    const gravados = (await arquivosDa(a.d.empresaA)).filter((chave) => chave.includes(sha256)).sort();
    assert.deepEqual(gravados, Object.values(chaves).sort(), 'exatamente os três arquivos desta imagem, nas chaves do armazenamento');
    for (const variante of ['mestre', 'exibicao', 'miniatura']) {
      assert.deepEqual(await lerFluxo(await a.armazenamento.abrir(chaves[variante])), esperado[variante], `${variante}: o arquivo gravado é a saída do processador`);
    }
    for (const variante of ['miniatura', 'exibicao']) {
      const e = await master('get', `${BASE}/empresa/${r.body.imagem.id}/${variante}`);
      assert.equal(e.status, 200, `${variante}: ${resumo(e)}`);
      assert.deepEqual(e.body, esperado[variante], `${variante}: a entrega devolve o que o envio gravou`);
      assert.equal(e.headers.etag, `"${sha256Hex(esperado[variante])}"`, `${variante}: ETag forte do SHA-256 da versão gravada`);
    }
  });

  test('UPL-07 — envios SIMULTÂNEOS do mesmo conteúdo na mesma empresa: um único 201 e os demais 200 reaproveitada=true com o MESMO id; uma linha, uma auditoria, três arquivos; no máximo 2 decodificações ao mesmo tempo', async () => {
    exigirApp();
    const bytes = png(340, 320);
    const sha256 = sha256Hex(bytes);
    const linhasAntes = await a.contagem('imagens_empresa', 'empresa_id = $1', [a.d.empresaA]);
    const respostas = await Promise.all(Array.from({ length: 6 }, (_, i) => enviar(bytes, { nome: `Simultânea ${i + 1}` })));
    assert.deepEqual(respostas.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 201], respostas.map(aviso).join(' | '));
    assert.equal(new Set(respostas.map((r) => r.body.imagem.id)).size, 1, 'todas as respostas apontam para a MESMA imagem');
    assert.deepEqual(respostas.map((r) => r.body.reaproveitada).sort(), [false, true, true, true, true, true]);
    const criada = respostas.find((r) => r.status === 201);
    assert.equal(await a.contagem('imagens_empresa', 'empresa_id = $1', [a.d.empresaA]), linhasAntes + 1, 'uma única linha nova');
    assert.equal((await a.auditorias('IMAGEM_MATERIAL_IMPORTADA', criada.body.imagem.id)).length, 1, 'uma única auditoria');
    assert.equal((await arquivosDa(a.d.empresaA)).filter((chave) => chave.includes(sha256)).length, 3, 'um único conjunto de três arquivos');
    assert.ok(processador.maximoSimultaneo <= 2, `no máximo 2 decodificações ao mesmo tempo (observado ${processador.maximoSimultaneo})`);
  });

  test('UPL-08 — cota: com a empresa na cota de bytes dos mestres o envio é 409 IMAGEM_COTA_EXCEDIDA e NADA é gravado (nem linha, nem arquivo, nem auditoria); a outra empresa segue enviando', async () => {
    exigirApp();
    const MIB = 1024 * 1024;
    const { rows: [{ usado }] } = await a.q('SELECT COALESCE(sum(bytes_mestre), 0)::bigint AS usado FROM imagens_empresa WHERE empresa_id = $1', [a.d.empresaB]);
    // Uma linha semeada pelo serviço da Unidade 3 leva a empresa B exatamente ao teto de 10 MiB de mestres (a cota é do ambiente deste arquivo).
    await a.imagemDaEmpresa(a.d.empresaB, a.d.masterB, { nome: 'Ocupa a cota UPL08', bytesMestre: 10 * MIB - Number(usado) });
    const antes = await fotografia(a.d.empresaB);
    const r = await enviar(png(350, 320), { quem: deB });
    assert.deepEqual([r.status, r.body.codigo], [409, 'IMAGEM_COTA_EXCEDIDA'], aviso(r));
    assert.deepEqual(await fotografia(a.d.empresaB), antes, 'a recusa por cota não deixa linha, arquivo nem auditoria');
    const outra = await enviar(png(351, 320));
    assert.equal(outra.status, 201, `a outra empresa não é afetada: ${aviso(outra)}`);
  });

  test('UPL-09 — a recusa por conteúdo não espera a trava da biblioteca: com a trava da empresa segurada por outra transação, uma imagem de dimensões inválidas é recusada (400) sem esperar', async () => {
    exigirApp();
    const segurando = await a.pool.connect();
    let relogio;
    try {
      await segurando.query('BEGIN');
      await imagemEmpresaRepo.travarBiblioteca(segurando, a.d.empresaA);
      const limite = new Promise((_resolver, rejeitar) => {
        relogio = setTimeout(() => rejeitar(new Error('contrato: o envio ficou esperando a trava da biblioteca da empresa enquanto validava o conteúdo da imagem')), 4000);
      });
      const r = await Promise.race([enviar(png(200, 200)), limite]);
      assert.deepEqual([r.status, r.body.codigo], [400, 'IMAGEM_DIMENSOES_INVALIDAS'], aviso(r));
    } finally {
      clearTimeout(relogio);
      await segurando.query('ROLLBACK').catch(() => {});
      segurando.release();
    }
  });

  // ENT-01 e ENT-02 (REATIVADOS na Unidade 5A-1): sem upload. A linha da imagem da empresa vem do serviço da Unidade 3, a da biblioteca padrão por INSERT
  // no schema temporário, e os arquivos são gravados pelo armazenamento da Unidade 1; os bytes são fictícios (contêiner WebP bem formado).
  const resumo = (r) => `${r.status} ${Buffer.isBuffer(r.body) ? `<${r.body.length} bytes ${r.headers['content-type'] ?? ''}>` : JSON.stringify(r.body)}`;

  test('ENT-01 — GET /:origem/:id/:variante devolve a derivada (image/webp) com nosniff, cache privado e ETag forte; miniatura e exibição da empresa; a miniatura da padrão também, e a exibição da padrão (ainda não registrada) é 404', async () => {
    exigirApp();
    const imagem = await semearEmpresa(a, { empresaId: a.d.empresaA, atorId: a.d.master, nome: 'Entrega ENT01' });
    for (const variante of ['miniatura', 'exibicao']) {
      const e = await master('get', `${BASE}/empresa/${imagem.id}/${variante}`);
      assert.equal(e.status, 200, `${variante}: ${resumo(e)}`);
      assert.deepEqual(e.body, imagem.bytes[variante], `${variante}: os bytes entregues são os gravados`);
      assert.match(e.headers['content-type'], /^image\/webp/);
      assert.equal(e.headers['x-content-type-options'], 'nosniff');
      assert.match(e.headers['cache-control'], /private/);
      assert.equal(e.headers.etag, `"${imagem.hashes[variante]}"`, `${variante}: ETag forte do SHA-256 da variante`);
    }
    const padrao = await semearPadrao(a, { nome: 'Padrão com arquivo ENT01' });
    const miniatura = await master('get', `${BASE}/padrao/${padrao.id}/miniatura`);
    assert.equal(miniatura.status, 200, `padrão, miniatura: ${resumo(miniatura)}`);
    assert.deepEqual(miniatura.body, padrao.bytes.miniatura, 'padrão, miniatura: os bytes entregues são os gravados');
    assert.match(miniatura.headers['content-type'], /^image\/webp/);
    assert.equal(miniatura.headers.etag, `"${padrao.hashes.miniatura}"`);
    const exibicao = await master('get', `${BASE}/padrao/${padrao.id}/exibicao`);
    assert.deepEqual([exibicao.status, exibicao.body.codigo], [404, 'IMAGEM_NAO_ENCONTRADA'], `padrão, exibição ainda não registrada: ${resumo(exibicao)}`);
  });

  test('ENT-02 — entrega isolada e uniforme: outra empresa, inexistente, inativa e variante desconhecida → 404 com o mesmo corpo e os mesmos cabeçalhos; sem sessão 401; sem visualizar 403', async () => {
    exigirApp();
    const imagem = await semearEmpresa(a, { empresaId: a.d.empresaA, atorId: a.d.master, nome: 'Entrega ENT02' });
    const inativa = await semearEmpresa(a, { empresaId: a.d.empresaA, atorId: a.d.master, nome: 'Inativa ENT02', inativar: true });
    const id = imagem.id;
    const propria = await master('get', `${BASE}/empresa/${id}/miniatura`);
    assert.equal(propria.status, 200, `âncora, a própria imagem: ${resumo(propria)}`);
    const deB = (metodo, url) => request(app)[metodo](url).set(CABECALHO, String(a.d.masterB));
    const r1 = await deB('get', `${BASE}/empresa/${id}/miniatura`);
    const r2 = await master('get', `${BASE}/empresa/987654321993/miniatura`);
    const r3 = await master('get', `${BASE}/empresa/${id}/original`);
    const r4 = await master('get', `${BASE}/empresa/${inativa.id}/miniatura`);
    for (const [nome, r] of [['outra empresa', r1], ['inexistente', r2], ['variante desconhecida', r3], ['inativa', r4]]) {
      assert.deepEqual([r.status, r.body.codigo], [404, 'IMAGEM_NAO_ENCONTRADA'], `${nome}: ${resumo(r)}`);
    }
    for (const [nome, r] of [['outra empresa', r1], ['variante desconhecida', r3], ['inativa', r4]]) {
      assert.deepEqual(r.body, r2.body, `${nome}: mesmo corpo da inexistente`);
      assert.deepEqual(cabecalhosComparaveis(r), cabecalhosComparaveis(r2), `${nome}: mesmos cabeçalhos da inexistente`);
    }
    const semSessao = await request(app).get(`${BASE}/empresa/${id}/miniatura`);
    assert.equal(semSessao.status, 401, resumo(semSessao));
    const soCriar = await a.usuarioCom(a.d.empresaA, { materials: ['criar'] });
    const semVisualizar = await request(app).get(`${BASE}/empresa/${id}/miniatura`).set(CABECALHO, String(soCriar));
    assert.equal(semVisualizar.status, 403, resumo(semVisualizar));
  });
});
