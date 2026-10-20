'use strict';

// Limites do ambiente de teste, lidos na carga: ANTES de carregar qualquer módulo de src/ (cada arquivo de teste roda em processo próprio). Taxas no teto, para que a
// bateria inteira (um mesmo MASTER enviando dezenas de vezes por minuto) nunca esbarre no 429, que tem teste próprio na camada de rotas.
process.env.IMAGENS_ENVIOS_POR_MINUTO_USUARIO = '60';
process.env.IMAGENS_ENVIOS_POR_HORA_EMPRESA = '1000';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const sharp = require('sharp');
const { montarAmbienteHttpImagens } = require('./helpers/imagem-material-http');
const { CABECALHO, sessaoDeTeste } = require('./helpers/ambiente-http-12d2');
const { criarAppTeste } = require('../helpers/app-teste');
const reais = require('../helpers/imagens-reais');
const { arquivosSob, pendentes } = require('../storage/helpers/tmp-seguro');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const { criarProcessadorDeImagens } = require('../../src/services/imagem-processador.service');
const { criarProcessadorDoAmbiente } = require('../../src/services/imagem-processador.ambiente');
const { criarEncerramento } = require('../../src/encerramento');
const { lerConfiguracao } = require('../../src/config/imagens');
const { PEDACOS_DE_METADADOS } = require('../../src/utils/imagem-container');

/**
 * Biblioteca de Imagens, Unidade 5C-6 — o envio de imagem de PONTA A PONTA com o processador REAL (processo filho com sharp), contra PostgreSQL real (schema
 * temporário exclusivo com todas as migrations) e armazenamento real em diretório temporário exclusivo, pela cadeia HTTP real das rotas da biblioteca.
 * O processador entra pelo MESMO portão que o app usa (`criarProcessadorDoAmbiente` com IMAGENS_PROCESSADOR_REAL=ativo), e cada filho iniciado é registrado para
 * provar o contrato do spawn e que nenhum sobra. Os 11 testes anteriores (imagem-material-http-upload-entrega.integration.js, com o processador falso) continuam valendo e
 * não são repetidos aqui: este arquivo acrescenta só o que depende do processador real.
 */

const BASE = '/api/imagens-material';
const FILHOS = path.join(__dirname, '..', 'helpers', 'filhos');
const filho = (nome) => path.join(FILHOS, nome);
const aviso = (r) => `${r.status} ${JSON.stringify(r.body)}`;
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const esperar = (ms) => new Promise((resolver) => { setTimeout(resolver, ms); });
const morto = (processo) => processo.exitCode !== null || processo.signalCode !== null;

async function aguardar(predicado, ms = 8000) {
  const limite = Date.now() + ms;
  while (Date.now() < limite) {
    if (predicado()) return true;
    await esperar(15);
  }
  return predicado();
}

describe('Biblioteca de Imagens — envio com o processador real, de ponta a ponta (Unidade 5C-6)', () => {
  let a;
  let sessaoTeste;
  let imagens;
  let processadorReal;
  let appReal;
  const enviados = {};
  const processadores = [];
  const registro = { chamadas: [] };

  function spawnar(comando, argumentos, opcoes) {
    const processo = spawn(comando, argumentos, opcoes);
    registro.chamadas.push({ comando, argumentos, opcoes, processo });
    return processo;
  }

  const novoProcessador = (opcoes = {}) => {
    const processador = criarProcessadorDeImagens({ spawnar, ...opcoes });
    processadores.push(processador);
    return processador;
  };

  const montarApp = ({ processador, armazenamento, exigirSessao } = {}) => criarAppTeste((app) => {
    app.use('/api', a.rotasDeImagem.criarRotas({
      controller: a.rotasDeImagem.criarController({ pool: a.pool, armazenamento: armazenamento ?? a.armazenamento, processador }),
      exigirSessao: exigirSessao ?? sessaoTeste,
      pool: a.pool,
    }));
  });

  const enviar = (app, usuario, bytes, { nome = 'Imagem E2E', tipo = 'image/png' } = {}) => request(app)
    .post(`${BASE}/empresa?nome=${encodeURIComponent(nome)}`)
    .set(CABECALHO, String(usuario))
    .set('Content-Type', tipo)
    .send(bytes);

  const obter = (app, usuario, url) => request(app).get(url).set(CABECALHO, String(usuario));

  const lerVariantes = (empresaId, sha) => {
    const pasta = path.join(a.raizDeImagens, String(empresaId), sha);
    return {
      mestre: fs.readFileSync(path.join(pasta, 'mestre.png')),
      exibicao: fs.readFileSync(path.join(pasta, 'exibicao.webp')),
      miniatura: fs.readFileSync(path.join(pasta, 'miniatura.webp')),
    };
  };

  // Tudo o que um envio bem-sucedido deixaria para trás numa empresa: linhas, arquivos e auditorias de importação.
  const fotografia = async (empresaId) => ({
    linhas: await a.contagem('imagens_empresa', 'empresa_id = $1', [empresaId]),
    arquivos: arquivosSob(a.raizDeImagens).filter((caminho) => caminho.split(path.sep)[0] === String(empresaId)),
    auditorias: await a.contagem('logs_auditoria', "acao = 'IMAGEM_MATERIAL_IMPORTADA' AND empresa_id = $1", [empresaId]),
  });

  const filhosIniciadosDesde = (marco) => registro.chamadas.slice(marco);

  before(async () => {
    a = await montarAmbienteHttpImagens({ comArmazenamento: true });
    assert.notEqual(a.rotasDeImagem, null, 'as rotas da biblioteca precisam existir');
    sessaoTeste = sessaoDeTeste(a.pool);
    processadorReal = criarProcessadorDoAmbiente({ origem: { IMAGENS_PROCESSADOR_REAL: 'ativo' }, fabrica: () => novoProcessador() });
    assert.notEqual(processadorReal, null, 'o portão do ambiente precisa entregar o processador real');
    appReal = montarApp({ processador: processadorReal });
    imagens = {
      validas: { PNG: await reais.png(640, 480), JPEG: await reais.jpeg(800, 600), WEBP: await reais.webp(700, 700) },
      comMetadados: await reais.jpeg(640, 640, { exif: true, xmp: true }),
      padrao: await reais.png(512, 512),
      controles: await reais.png(520, 520),
      falhas: await reais.png(530, 530),
      disco: await reais.png(540, 540),
      saturacao: await reais.png(550, 550),
      encerramento: await reais.png(560, 560),
      ambiente: await reais.png(570, 570),
    };
  });

  after(async () => {
    for (const processador of processadores) await processador.encerrarTodos();
    const vivos = registro.chamadas.map(({ processo }) => processo).filter((processo) => !morto(processo));
    for (const processo of vivos) processo.kill('SIGKILL');
    if (a) await a.encerrar();
    assert.equal(vivos.length, 0, 'nenhum filho pode sobreviver ao fim do arquivo');
    assert.deepEqual(pendentes(), [], 'nenhum diretório temporário pode sobrar');
  });

  test('E2E-01 — SEM processador (o padrão de todo ambiente não autorizado): 503 IMAGENS_INDISPONIVEL; nada é processado, gravado nem registrado e nenhum filho é iniciado', async () => {
    const app = montarApp({ processador: null });
    const antes = await fotografia(a.d.empresaA);
    const marco = registro.chamadas.length;
    const r = await enviar(app, a.d.master, imagens.padrao);
    assert.equal(r.status, 503, aviso(r));
    assert.equal(r.body.codigo, 'IMAGENS_INDISPONIVEL');
    assert.deepEqual(await fotografia(a.d.empresaA), antes);
    assert.equal(filhosIniciadosDesde(marco).length, 0);
  });

  test('E2E-02 — PNG, JPEG e WebP válidos → 201 com a imagem registrada (PNG 1024×1024, versão 1, ATIVA), reaproveitada=false e três arquivos novos cada', async () => {
    const formatos = [['PNG', 'image/png'], ['JPEG', 'image/jpeg'], ['WEBP', 'image/webp']];
    for (const [rotulo, tipo] of formatos) {
      const bytes = imagens.validas[rotulo];
      const antes = await fotografia(a.d.empresaA);
      const r = await enviar(appReal, a.d.master, bytes, { nome: `Luva ${rotulo}`, tipo });
      assert.equal(r.status, 201, aviso(r));
      assert.deepEqual(Object.keys(r.body).sort(), ['imagem', 'reaproveitada', 'status']);
      assert.equal(r.body.reaproveitada, false);
      assert.match(r.body.imagem.id, /^[1-9][0-9]*$/);
      assert.deepEqual(r.body.imagem, { origem: 'EMPRESA', id: r.body.imagem.id, nome: `Luva ${rotulo}`, formato: 'PNG', largura: 1024, altura: 1024, versao: 1, estado: 'ATIVA' });
      a.semCamposInternos(r.body, rotulo);
      const depois = await fotografia(a.d.empresaA);
      assert.equal(depois.linhas, antes.linhas + 1, rotulo);
      assert.equal(depois.auditorias, antes.auditorias + 1, rotulo);
      assert.equal(depois.arquivos.length, antes.arquivos.length + 3, rotulo);
      enviados[rotulo] = { id: r.body.imagem.id, sha: sha256(bytes), bytes };
    }
    assert.equal(new Set(Object.values(enviados).map((e) => e.id)).size, 3);
  });

  test('E2E-03 — integridade das três variantes: formato, medidas e tetos; SHA-256 e bytes iguais aos da linha; sem metadados; decodificáveis; conteúdo no lugar certo', async () => {
    assert.equal(Object.keys(enviados).length, 3, 'depende do E2E-02');
    for (const [rotulo, enviado] of Object.entries(enviados)) {
      const linha = (await a.q('SELECT * FROM imagens_empresa WHERE id = $1', [enviado.id])).rows[0];
      const arquivos = lerVariantes(a.d.empresaA, enviado.sha);
      assert.equal(linha.sha256, enviado.sha, rotulo);
      assert.deepEqual([linha.formato, linha.largura, linha.altura, linha.versao, linha.estado], ['PNG', 1024, 1024, 1, 'ATIVA'], rotulo);
      for (const variante of ['mestre', 'exibicao', 'miniatura']) {
        assert.equal(sha256(arquivos[variante]), linha[`sha256_${variante}`], `${rotulo} ${variante}: SHA-256 do arquivo = linha`);
        assert.equal(arquivos[variante].length, linha[`bytes_${variante}`], `${rotulo} ${variante}: bytes do arquivo = linha`);
      }
      assert.ok(arquivos.mestre.length <= 4 * 1024 * 1024 && arquivos.exibicao.length <= 512 * 1024 && arquivos.miniatura.length <= 64 * 1024, `${rotulo}: tetos de tamanho`);
      const [m, e, t] = await Promise.all([sharp(arquivos.mestre).metadata(), sharp(arquivos.exibicao).metadata(), sharp(arquivos.miniatura).metadata()]);
      assert.deepEqual([m.format, m.width, m.height], ['png', 1024, 1024], `${rotulo}: mestre`);
      assert.deepEqual([e.format, e.width, e.height], ['webp', 640, 640], `${rotulo}: exibição`);
      assert.deepEqual([t.format, t.width, t.height], ['webp', 320, 320], `${rotulo}: miniatura`);
      for (const pedaco of reais.pedacosPng(arquivos.mestre)) assert.equal(PEDACOS_DE_METADADOS.has(pedaco), false, `${rotulo}: pedaço de metadados ${pedaco} no mestre`);
      for (const variante of ['exibicao', 'miniatura']) {
        for (const pedaco of reais.pedacosWebp(arquivos[variante])) assert.equal(PEDACOS_DE_METADADOS.has(pedaco), false, `${rotulo}: pedaço de metadados ${pedaco} na ${variante}`);
      }
      for (const variante of ['mestre', 'exibicao', 'miniatura']) await sharp(arquivos[variante], { failOn: 'warning' }).raw().toBuffer();
    }
    const png = lerVariantes(a.d.empresaA, enviados.PNG.sha);
    const perto = (obtido, esperado, tolerancia) => obtido.every((canal, i) => Math.abs(canal - esperado[i]) <= tolerancia);
    for (const [x, y, cor] of [[256, 320, [255, 0, 0, 255]], [768, 320, [0, 255, 0, 255]], [256, 704, [0, 0, 255, 255]], [768, 704, [255, 255, 0, 255]], [10, 10, [0, 0, 0, 0]]]) {
      assert.ok(perto(await reais.pixel(png.mestre, x, y), cor, 2), `mestre (${x},${y}) deveria ser ${cor}`);
    }
    for (const [x, y, cor] of [[160, 200, [255, 0, 0, 255]], [480, 200, [0, 255, 0, 255]], [160, 440, [0, 0, 255, 255]], [480, 440, [255, 255, 0, 255]]]) {
      assert.ok(perto(await reais.pixel(png.exibicao, x, y), cor, 8), `exibição (${x},${y}) deveria ser ${cor}`);
    }
  });

  test('E2E-04 — entrega: miniatura e exibição voltam como image/webp com exatamente os bytes gravados; o mestre nunca é entregue', async () => {
    const { id, sha } = enviados.PNG;
    const arquivos = lerVariantes(a.d.empresaA, sha);
    for (const variante of ['miniatura', 'exibicao']) {
      const r = await obter(appReal, a.d.master, `${BASE}/empresa/${id}/${variante}?v=1`);
      assert.equal(r.status, 200, `${variante}: ${r.status}`);
      assert.match(r.headers['content-type'], /^image\/webp/);
      assert.equal(r.headers['x-content-type-options'], 'nosniff');
      assert.equal(Buffer.compare(r.body, arquivos[variante]), 0, `${variante}: bytes entregues = bytes gravados`);
      assert.equal((await sharp(r.body).metadata()).format, 'webp');
    }
    const mestre = await obter(appReal, a.d.master, `${BASE}/empresa/${id}/mestre`);
    assert.equal(mestre.status, 404, aviso(mestre));
  });

  test('E2E-05 — metadados do arquivo enviado (EXIF com GPS e direitos autorais, XMP) não chegam a nenhum arquivo gravado, à linha, à auditoria nem à resposta', async () => {
    const segredos = ['Segredo Ltda', 'AUTOR-SECRETO', 'CameraSecreta'];
    const entrada = imagens.comMetadados.toString('latin1');
    for (const segredo of segredos) assert.ok(entrada.includes(segredo), `o controle precisa conter ${segredo} na entrada`);
    const r = await enviar(appReal, a.d.master, imagens.comMetadados, { nome: 'Luva com metadados', tipo: 'image/jpeg' });
    assert.equal(r.status, 201, aviso(r));
    const arquivos = lerVariantes(a.d.empresaA, sha256(imagens.comMetadados));
    for (const [variante, conteudo] of Object.entries(arquivos)) {
      for (const segredo of segredos) assert.equal(conteudo.toString('latin1').includes(segredo), false, `${variante} contém ${segredo}`);
    }
    const linha = (await a.q('SELECT * FROM imagens_empresa WHERE id = $1', [r.body.imagem.id])).rows[0];
    const auditorias = await a.auditorias('IMAGEM_MATERIAL_IMPORTADA', r.body.imagem.id);
    const visivel = JSON.stringify([r.body, linha, auditorias]);
    for (const segredo of segredos) assert.equal(visivel.includes(segredo), false, `resposta, linha ou auditoria contém ${segredo}`);
  });

  test('E2E-06 — reenvio da MESMA imagem (inclusive com outro nome): 200 reaproveitada=true, mesmo id e nome original; nada novo em linhas, arquivos nem auditoria', async (t) => {
    const { id, bytes } = enviados.PNG;
    const antes = await fotografia(a.d.empresaA);
    const marco = registro.chamadas.length;
    const mesma = await enviar(appReal, a.d.master, bytes, { nome: 'Luva PNG', tipo: 'image/png' });
    const outroNome = await enviar(appReal, a.d.master, bytes, { nome: 'Outro nome', tipo: 'image/png' });
    for (const r of [mesma, outroNome]) {
      assert.equal(r.status, 200, aviso(r));
      assert.equal(r.body.reaproveitada, true);
      assert.equal(r.body.imagem.id, id);
      assert.equal(r.body.imagem.nome, 'Luva PNG');
    }
    assert.deepEqual(await fotografia(a.d.empresaA), antes);
    t.diagnostic(`observação: os dois reenvios iniciaram ${filhosIniciadosDesde(marco).length} filho(s); a deduplicação por SHA-256 acontece no registro, depois do processamento`);
  });

  test('E2E-07 — isolamento entre empresas: a B envia os MESMOS bytes e recebe imagem própria, em pasta própria; a A não é tocada e nenhuma enxerga a imagem da outra', async () => {
    const { id: idA, bytes } = enviados.PNG;
    const antesA = await fotografia(a.d.empresaA);
    const antesB = await fotografia(a.d.empresaB);
    const rB = await enviar(appReal, a.d.masterB, bytes, { nome: 'Luva da B', tipo: 'image/png' });
    assert.equal(rB.status, 201, aviso(rB));
    assert.equal(rB.body.reaproveitada, false);
    assert.notEqual(rB.body.imagem.id, idA);
    assert.deepEqual(await fotografia(a.d.empresaA), antesA);
    const depoisB = await fotografia(a.d.empresaB);
    assert.equal(depoisB.linhas, antesB.linhas + 1);
    assert.equal(depoisB.arquivos.length, antesB.arquivos.length + 3);
    const linhaB = (await a.q('SELECT empresa_id, criado_por FROM imagens_empresa WHERE id = $1', [rB.body.imagem.id])).rows[0];
    assert.deepEqual([linhaB.empresa_id, linhaB.criado_por], [a.d.empresaB, a.d.masterB]);

    const deBsobreA = await obter(appReal, a.d.masterB, `${BASE}/empresa/${idA}/miniatura`);
    const inexistente = await obter(appReal, a.d.masterB, `${BASE}/empresa/999999999/miniatura`);
    assert.equal(deBsobreA.status, 404, aviso(deBsobreA));
    assert.deepEqual(deBsobreA.body, inexistente.body, 'o 404 da imagem de outra empresa é igual ao da inexistente');
    assert.equal((await obter(appReal, a.d.master, `${BASE}/empresa/${rB.body.imagem.id}/miniatura`)).status, 404);
    assert.equal((await obter(appReal, a.d.masterB, `${BASE}/empresa/${rB.body.imagem.id}/miniatura`)).status, 200);

    const listaB = await obter(appReal, a.d.masterB, `${BASE}?origem=EMPRESA&estado=TODAS&limite=100`);
    assert.equal(listaB.status, 200, aviso(listaB));
    assert.deepEqual(listaB.body.imagens.map((i) => i.id), [rB.body.imagem.id]);
  });

  test('E2E-08 — arquivos inválidos ou excessivos: recusa pública controlada, nada gravado nem registrado; só o que passa da inspeção chega a um filho', async () => {
    const png400 = await reais.png(400, 400);
    const jpeg400 = await reais.jpeg(400, 400);
    const webp400 = await reais.webp(400, 400);
    const casos = [
      ['texto', reais.texto(), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO', 0],
      ['GIF', await reais.gif(), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO', 0],
      ['BMP', reais.bmp(), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO', 0],
      ['PDF', reais.pdf(), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO', 0],
      ['SVG', reais.svg(), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO', 0],
      ['executável ELF', reais.elf(), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO', 0],
      ['PNG seguido de ZIP (poliglota)', Buffer.concat([png400, reais.zip()]), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO', 0],
      ['JPEG seguido de ZIP (poliglota)', Buffer.concat([jpeg400, reais.zip()]), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO', 0],
      ['WebP seguido de ZIP (poliglota)', Buffer.concat([webp400, reais.zip()]), 415, 'IMAGEM_FORMATO_NAO_SUPORTADO', 0],
      ['WebP animado', await reais.webpAnimado(), 415, 'IMAGEM_ANIMADA_NAO_SUPORTADA', 0],
      ['APNG', reais.apng(png400), 415, 'IMAGEM_ANIMADA_NAO_SUPORTADA', 0],
      ['PNG 200×200 (abaixo do mínimo)', await reais.png(200, 200), 400, 'IMAGEM_DIMENSOES_INVALIDAS', 0],
      ['PNG 5000×5000 (acima do limite de pixels, poucos bytes)', await reais.pngDePixelsEnormes(5000, 5000), 400, 'IMAGEM_DIMENSOES_INVALIDAS', 0],
      ['PNG que declara 60000×60000', reais.pngComDimensoesDeclaradas(60000, 60000), 400, 'IMAGEM_DIMENSOES_INVALIDAS', 0],
      ['PNG truncado', reais.truncar(png400, 0.5), 400, 'IMAGEM_INVALIDA', 0],
      ['PNG com CRC corrompido (chega ao filho)', reais.pngComCrcCorrompido(png400), 400, 'IMAGEM_INVALIDA', 1],
      ['JPEG cortado e fechado com EOI (chega ao filho)', reais.jpegCortadoComEoi(jpeg400), 400, 'IMAGEM_INVALIDA', 1],
      ['corpo acima de 2 MiB', Buffer.alloc(2 * 1024 * 1024 + 1, 1), 413, 'PAYLOAD_MUITO_GRANDE', 0],
    ];
    const antes = await fotografia(a.d.empresaA);
    for (const [rotulo, bytes, status, codigo, filhos] of casos) {
      const marco = registro.chamadas.length;
      const r = await enviar(appReal, a.d.master, bytes, { nome: `Recusa ${rotulo}`.slice(0, 100), tipo: 'image/png' });
      assert.deepEqual([r.status, r.body.codigo], [status, codigo], `${rotulo}: ${aviso(r)}`);
      assert.equal(filhosIniciadosDesde(marco).length, filhos, `${rotulo}: filhos iniciados`);
      for (const iniciado of filhosIniciadosDesde(marco)) assert.equal(await aguardar(() => morto(iniciado.processo), 5000), true, `${rotulo}: o filho precisa terminar`);
    }
    assert.deepEqual(await fotografia(a.d.empresaA), antes, 'nenhuma recusa deixa linha, arquivo ou auditoria');
  });

  test('E2E-09 — controles preservados: sem sessão 401 e sem materials.criar 403 ANTES de qualquer filho; empresa e ator só da sessão; o cliente não escolhe a empresa', async () => {
    const antes = await fotografia(a.d.empresaA);
    const antesB = await fotografia(a.d.empresaB);
    const marco = registro.chamadas.length;

    const semSessao = await request(montarApp({ processador: processadorReal, exigirSessao: criarExigirSessao({ pool: a.pool }) }))
      .post(`${BASE}/empresa?nome=Sem%20sessao`).set('Content-Type', 'image/png').send(imagens.controles);
    assert.equal(semSessao.status, 401, aviso(semSessao));
    const leitor = await a.usuarioCom(a.d.empresaA, { materials: ['visualizar'] });
    const semPermissao = await enviar(appReal, leitor, imagens.controles, { nome: 'Sem permissão' });
    assert.equal(semPermissao.status, 403, aviso(semPermissao));
    assert.deepEqual(await fotografia(a.d.empresaA), antes);
    assert.equal(filhosIniciadosDesde(marco).length, 0, 'nenhum filho para quem não pode enviar');

    const criador = await a.usuarioCom(a.d.empresaA, { materials: ['visualizar', 'criar'] });
    const ok = await enviar(appReal, criador, imagens.controles, { nome: 'Usuário com criar' });
    assert.equal(ok.status, 201, aviso(ok));
    const linha = (await a.q('SELECT empresa_id, criado_por FROM imagens_empresa WHERE id = $1', [ok.body.imagem.id])).rows[0];
    assert.deepEqual([linha.empresa_id, linha.criado_por], [a.d.empresaA, criador]);

    const forjado = await request(appReal).post(`${BASE}/empresa?nome=Forjada&empresaId=${a.d.empresaB}`)
      .set(CABECALHO, String(criador)).set('Content-Type', 'image/png').send(await reais.png(580, 580));
    assert.equal(forjado.status, 400, aviso(forjado));
    assert.deepEqual(await fotografia(a.d.empresaB), antesB, 'a empresa B não recebe nada');
  });

  test('E2E-10 — auditoria: uma linha IMAGEM_MATERIAL_IMPORTADA por imagem nova, só com id, formato e a soma dos bytes; sem hash, chave, caminho ou conteúdo', async () => {
    const { id, sha } = enviados.JPEG;
    const linhas = await a.auditorias('IMAGEM_MATERIAL_IMPORTADA', id);
    assert.equal(linhas.length, 1);
    assert.deepEqual([linhas[0].empresa_id, linhas[0].usuario_id], [a.d.empresaA, a.d.master]);
    assert.deepEqual(Object.keys(linhas[0].contexto).sort(), ['bytes', 'formato', 'imagemId']);
    const linha = (await a.q('SELECT * FROM imagens_empresa WHERE id = $1', [id])).rows[0];
    assert.equal(linhas[0].contexto.bytes, linha.bytes_mestre + linha.bytes_exibicao + linha.bytes_miniatura);
    assert.equal(linhas[0].contexto.formato, 'PNG');
    const visivel = JSON.stringify(linhas);
    for (const proibido of [sha, linha.sha256_mestre, linha.sha256_exibicao, linha.sha256_miniatura, a.raizDeImagens, 'mestre.png', 'exibicao.webp']) {
      assert.equal(visivel.includes(proibido), false, `a auditoria vazou ${proibido}`);
    }
  });

  test('E2E-11 — contrato do filho: sem shell, ambiente mínimo com UV_THREADPOOL_SIZE=4, memória limitada, geração de código desligada e pasta neutra — nos spawns feitos e no que um filho realmente recebe', async () => {
    const doWorker = registro.chamadas.filter(({ argumentos }) => argumentos.some((argumento) => String(argumento).endsWith('imagem-processador.worker.js')));
    assert.ok(doWorker.length >= 5, `filhos reais iniciados até aqui: ${doWorker.length}`);
    const esperadas = ['MALLOC_ARENA_MAX', 'PATH', 'TMPDIR', 'UV_THREADPOOL_SIZE', 'VIPS_BLOCK_UNTRUSTED'];
    for (const { comando, argumentos, opcoes } of doWorker) {
      assert.equal(comando, process.execPath);
      assert.equal(argumentos[0], '--max-old-space-size=192');
      assert.equal(argumentos[1], '--disallow-code-generation-from-strings');
      assert.equal(opcoes.shell, false);
      assert.deepEqual(Object.keys(opcoes.env).sort(), esperadas);
      assert.equal(opcoes.env.UV_THREADPOOL_SIZE, '4');
      assert.equal(opcoes.env.VIPS_BLOCK_UNTRUSTED, '1');
      assert.equal(opcoes.cwd, os.tmpdir());
      assert.equal(typeof JSON.parse(argumentos[3]).ladoMax, 'number', 'o único argumento de dados é o JSON dos limites numéricos');
    }

    let impresso = '';
    const comCaptura = (comando, argumentos, opcoes) => {
      const processo = spawnar(comando, argumentos, opcoes);
      processo.stdout.on('data', (bloco) => { impresso += bloco; });
      return processo;
    };
    const processador = novoProcessador({ caminhoDoFilho: filho('imprime-ambiente-valores.js'), spawnar: comCaptura });
    const r = await enviar(montarApp({ processador }), a.d.master, imagens.ambiente, { nome: 'Ambiente do filho' });
    assert.equal(r.status, 500, aviso(r));
    const recebido = JSON.parse(impresso.trim());
    assert.deepEqual(recebido.valores, { PATH: '/usr/bin:/bin', TMPDIR: os.tmpdir(), UV_THREADPOOL_SIZE: '4', VIPS_BLOCK_UNTRUSTED: '1', MALLOC_ARENA_MAX: '2' });
    assert.ok(recebido.chaves.every((chave) => [...esperadas, '__CF_USER_TEXT_ENCODING'].includes(chave)), `variáveis vistas pelo filho: ${recebido.chaves}`);
    assert.ok(recebido.execArgv.includes('--max-old-space-size=192') && recebido.execArgv.includes('--disallow-code-generation-from-strings'));
    assert.equal(fs.realpathSync(recebido.cwd), fs.realpathSync(os.tmpdir()));
  });

  test('E2E-12 — falhas do processamento: cada uma vira uma resposta pública genérica, não deixa linha, arquivo nem auditoria, não vaza detalhe interno e não deixa filho vivo', async () => {
    const lancador = () => { throw new Error('EAGAIN simulado /Users/segredo'); };
    const falhas = [
      ['filho travado além do prazo externo', { caminhoDoFilho: filho('travado.js'), prazoExternoMs: 400, esperaPelaMorteMs: 300 }, 422, 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO'],
      ['relógio de sobrevivência do filho (código 124)', { caminhoDoFilho: filho('sai-com-124.js') }, 422, 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO'],
      ['decodificador indisponível (sharp não carregou)', { caminhoDoFilho: filho('sem-sharp.js') }, 503, 'IMAGENS_INDISPONIVEL'],
      ['não foi possível iniciar o filho', { spawnar: lancador }, 503, 'IMAGENS_INDISPONIVEL'],
      ['resposta que não é um quadro', { caminhoDoFilho: filho('lixo.js') }, 500, null],
      ['filho cai deixando segredo na saída de erro', { caminhoDoFilho: filho('escreve-stderr-e-cai.js') }, 500, null],
      ['saída gigante', { caminhoDoFilho: filho('saida-gigante.js') }, 500, null],
      ['variante com medida errada', { caminhoDoFilho: filho('sucesso-largura-errada.js') }, 500, null],
      ['carga depois do fim do quadro', { caminhoDoFilho: filho('sucesso-carga-depois-do-fim.js') }, 500, null],
      ['mestre com metadados', { caminhoDoFilho: filho('sucesso-mestre-com-metadados.js') }, 500, null],
    ];
    const antes = await fotografia(a.d.empresaA);
    for (const [rotulo, opcoes, status, codigo] of falhas) {
      const marco = registro.chamadas.length;
      const app = montarApp({ processador: novoProcessador(opcoes) });
      const r = await enviar(app, a.d.master, imagens.falhas, { nome: `Falha ${rotulo}`.slice(0, 100) });
      assert.equal(r.status, status, `${rotulo}: ${aviso(r)}`);
      if (codigo !== null) assert.equal(r.body.codigo, codigo, rotulo);
      const visivel = JSON.stringify(r.body);
      for (const proibido of ['SEGREDO-NO-STDERR-123', '/home/usuario', '/Users/', 'IMAGEM_FILHO', 'EAGAIN', 'worker', 'stack']) {
        assert.equal(visivel.includes(proibido), false, `${rotulo}: a resposta vazou "${proibido}"`);
      }
      assert.deepEqual(await fotografia(a.d.empresaA), antes, `${rotulo}: nada parcial`);
      for (const iniciado of filhosIniciadosDesde(marco)) assert.equal(await aguardar(() => morto(iniciado.processo), 5000), true, `${rotulo}: filho ainda vivo`);
    }
  });

  test('E2E-13 — falha do disco na terceira gravação: 500 genérico, sem linha nem auditoria; ficam só os arquivos já gravados (decisão D-C3) e o reenvio é bem-sucedido, completando o conjunto', async (t) => {
    const bytes = imagens.disco;
    const antes = await fotografia(a.d.empresaA);
    let escritas = 0;
    const armazenamentoQueFalha = {
      ...a.armazenamento,
      gravar: async (...argumentos) => {
        escritas += 1;
        if (escritas === 3) throw new Error('disco cheio simulado /var/segredo');
        return a.armazenamento.gravar(...argumentos);
      },
    };
    const r = await enviar(montarApp({ processador: processadorReal, armazenamento: armazenamentoQueFalha }), a.d.master, bytes, { nome: 'Falha de disco' });
    assert.equal(r.status, 500, aviso(r));
    for (const proibido of ['disco cheio', '/var/segredo']) assert.equal(JSON.stringify(r.body).includes(proibido), false, `a resposta vazou "${proibido}"`);
    const meio = await fotografia(a.d.empresaA);
    assert.equal(meio.linhas, antes.linhas, 'nenhuma linha');
    assert.equal(meio.auditorias, antes.auditorias, 'nenhuma auditoria');
    assert.equal(meio.arquivos.length, antes.arquivos.length + 2, 'mestre e exibição, já gravados, ficam: o envio nunca remove arquivo dentro da requisição');
    t.diagnostic(`observação: ${meio.arquivos.length - antes.arquivos.length} arquivo(s) órfão(s) após a falha do disco, sem linha que os referencie (limpeza física é rotina futura)`);

    const depois = await enviar(appReal, a.d.master, bytes, { nome: 'Falha de disco' });
    assert.equal(depois.status, 201, aviso(depois));
    const fim = await fotografia(a.d.empresaA);
    assert.equal(fim.linhas, antes.linhas + 1);
    assert.equal(fim.auditorias, antes.auditorias + 1);
    assert.equal(fim.arquivos.length, antes.arquivos.length + 3);
    const linha = (await a.q('SELECT * FROM imagens_empresa WHERE id = $1', [depois.body.imagem.id])).rows[0];
    const arquivos = lerVariantes(a.d.empresaA, sha256(bytes));
    for (const variante of ['mestre', 'exibicao', 'miniatura']) assert.equal(sha256(arquivos[variante]), linha[`sha256_${variante}`], variante);
  });

  test('E2E-14 — concorrência e fila preservadas com filhos reais: no máximo 2 ao mesmo tempo, 8 na fila e as excedentes recusadas com 503 IMAGENS_OCUPADO e Retry-After', { timeout: 90000 }, async () => {
    const configuracao = lerConfiguracao(process.env);
    const simultaneos = configuracao.processamentosSimultaneos;
    const { maxima, retryAfterFilaCheiaSegundos } = configuracao.processamento.fila;
    assert.deepEqual([simultaneos, maxima], [2, 8]);
    // 1,5 s por filho: folga larga para os 12 pedidos chegarem ao semáforo antes de o primeiro filho expirar, mesmo em máquina lenta.
    const processador = novoProcessador({ caminhoDoFilho: filho('travado.js'), prazoExternoMs: 1500, esperaPelaMorteMs: 300 });
    const app = montarApp({ processador });
    const antes = await fotografia(a.d.empresaA);
    const total = simultaneos + maxima + 2;
    let maximoVisto = 0;
    const amostra = setInterval(() => { maximoVisto = Math.max(maximoVisto, processador.ativos().length); }, 10);
    let respostas;
    try {
      respostas = await Promise.all(Array.from({ length: total }, (_, i) => enviar(app, a.d.master, imagens.saturacao, { nome: `Saturação ${i}` })));
    } finally {
      clearInterval(amostra);
    }
    const ocupadas = respostas.filter((r) => r.status === 503);
    const expiradas = respostas.filter((r) => r.status === 422);
    assert.equal(ocupadas.length, 2, respostas.map((r) => r.status).join(','));
    assert.equal(expiradas.length, simultaneos + maxima, respostas.map((r) => r.status).join(','));
    for (const r of ocupadas) {
      assert.equal(r.body.codigo, 'IMAGENS_OCUPADO');
      assert.equal(r.headers['retry-after'], String(retryAfterFilaCheiaSegundos));
    }
    for (const r of expiradas) assert.equal(r.body.codigo, 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO');
    assert.equal(maximoVisto, simultaneos, `filhos simultâneos observados: ${maximoVisto}`);
    assert.equal(processador.ativos().length, 0);
    assert.deepEqual(await fotografia(a.d.empresaA), antes);
  });

  test('E2E-15 — encerramento controlado: com um envio em andamento, o sinal faz encerrarTodos() matar o filho ANTES da saída; o pedido termina com erro genérico, sem linha, arquivo nem filho vivo', { timeout: 60000 }, async () => {
    const processador = novoProcessador({ caminhoDoFilho: filho('travado.js'), prazoExternoMs: 30000, esperaPelaMorteMs: 1000 });
    const app = montarApp({ processador });
    const antes = await fotografia(a.d.empresaA);
    const marco = registro.chamadas.length;
    // O supertest só envia ao ser aguardado: o `then` explícito dispara o pedido agora.
    const pedido = enviar(app, a.d.master, imagens.encerramento, { nome: 'Em andamento' }).then((resposta) => resposta);
    assert.equal(await aguardar(() => processador.ativos().length === 1), true, 'o filho precisa estar vivo antes do sinal');
    const iniciado = filhosIniciadosDesde(marco)[0].processo;
    assert.equal(morto(iniciado), false);

    const eventos = [];
    const encerramento = criarEncerramento({
      servidor: { close: () => { eventos.push('servidor.close'); } },
      servico: { parar: () => { eventos.push('servico.parar'); }, aguardarOciosidade: async () => ({ pendentes: 0 }), fechar: async () => { eventos.push('servico.fechar'); } },
      processos: processador,
      sair: (codigo) => { eventos.push(`sair(${codigo}) com ${processador.ativos().length} filhos ativos e filho morto=${morto(iniciado)}`); },
      registrar: () => {},
    });
    await encerramento.encerrar('SIGTERM');
    assert.deepEqual(eventos, ['servidor.close', 'servico.parar', 'servico.fechar', 'sair(0) com 0 filhos ativos e filho morto=true']);

    const r = await pedido;
    assert.equal(r.status, 500, aviso(r));
    assert.equal(JSON.stringify(r.body).includes('IMAGEM_FILHO'), false);
    assert.deepEqual(await fotografia(a.d.empresaA), antes);
    assert.equal(processador.ativos().length, 0);
  });
});
