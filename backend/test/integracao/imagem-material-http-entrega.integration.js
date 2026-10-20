'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const path = require('node:path');
const request = require('supertest');
const { montarAmbienteHttpImagens } = require('./helpers/imagem-material-http');
const { CABECALHO } = require('./helpers/ambiente-http-12d2');
const { criarExigirSessao } = require('../../src/middleware/autenticacao');
const imagemEmpresaRepo = require('../../src/repositories/imagem-empresa.repository');
const imagemPadraoRepo = require('../../src/repositories/imagem-padrao.repository');
const servico = require('../../src/services/imagem-material.service');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const { sha256Hex, webpFicticio, pngFicticio } = require('../helpers/imagens-ficticias');
const {
  semearEmpresa, semearPadrao, instrumentar, cabecalhosComparaveis, capturarErros, tokensDeVary, comAmbiente,
} = require('./helpers/imagem-material-entrega');

/**
 * Biblioteca de Imagens, Unidade 5A-1 (RED) — a ENTREGA de arquivos por HTTP (PostgreSQL real em schema temporário, armazenamento real em
 * diretório temporário exclusivo, rotas reais da biblioteca, sessão de teste por cabeçalho). Complementa ENT-01 e ENT-02 (arquivo
 * imagem-material-http-upload-entrega.integration.js, reativados). Contrato:
 *
 *   GET|HEAD /api/imagens-material/:origem/:id/:variante?v=<versao>     sessão -> materials.visualizar -> validação -> entrega
 *   origem padrao|empresa · variante miniatura|exibicao · id BIGINT canônico (400 ID_INVALIDO) · v opcional (400 se inválido) · query só `v`.
 *   200 image/webp + nosniff + ETag forte (SHA-256 da variante) + Vary: Cookie + Cache-Control private (imutável só com v = versão atual).
 *   404 IMAGEM_NAO_ENCONTRADA UNIFORME (corpo e cabeçalhos idênticos) para: inexistente, outra empresa, inativa, origem/variante desconhecida,
 *   exibição sem arquivo registrado, arquivo ausente, adulterado, truncado, vazio, que não é WebP ou acima do teto. 503 IMAGENS_INDISPONIVEL sem
 *   armazenamento, ANTES de consultar a existência de qualquer imagem. O 304 só acontece DEPOIS de a existência e a integridade do arquivo serem
 *   conferidas. Nada do cliente chega ao sistema de arquivos: a chave sai do banco.
 *
 * Fixtures sem upload: a linha vem do serviço da Unidade 3 e os arquivos são gravados pelo armazenamento da Unidade 1 (bytes fictícios). Cada teste
 * que corrompe um arquivo usa a PRÓPRIA imagem. Todo teste de 404/negação começa por uma âncora que precisa devolver 200 (não passa "no vazio").
 */

const BASE = '/api/imagens-material';
const url = (origem, id, variante, query = '') => `${BASE}/${origem}/${id}/${variante}${query}`;
const corpoDe = (r) => (Buffer.isBuffer(r.body) ? `<${r.body.length} bytes ${r.headers['content-type'] ?? ''}>` : JSON.stringify(r.body));
const aviso = (r) => `${r.status} ${corpoDe(r)}`;
const ok200 = (r, bytes, onde = '') => {
  assert.equal(r.status, 200, `${onde} ${aviso(r)}`);
  assert.deepEqual(r.body, bytes, `${onde} os bytes entregues não são os gravados`);
};
const n404 = (r, onde = '') => {
  assert.deepEqual([r.status, r.body?.codigo], [404, 'IMAGEM_NAO_ENCONTRADA'], `${onde} ${aviso(r)}`);
  assert.equal(Buffer.isBuffer(r.body), false, `${onde} nenhum byte de imagem numa recusa`);
};
const semCorpo = (r) => (Buffer.isBuffer(r.body) ? r.body.length === 0 : Object.keys(r.body ?? {}).length === 0);

/**
 * Sobe o app numa porta efêmera e entrega a `fn` uma função `bruto(caminho)`: o caminho vai EXATAMENTE como está, porque um cliente HTTP comum
 * (supertest) normaliza segmentos `..` e `%2e%2e` antes de enviar e esses pedidos nunca chegariam ao servidor. O servidor é sempre encerrado.
 */
async function comPedidosCrus(app, usuarioId, fn) {
  const servidor = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  const bruto = (caminho) => new Promise((resolve, reject) => {
    const pedido = http.request({
      host: '127.0.0.1', port: servidor.address().port, path: caminho, method: 'GET', agent: false, headers: { [CABECALHO]: String(usuarioId) },
    }, (resposta) => {
      const partes = [];
      resposta.on('data', (bloco) => partes.push(bloco));
      resposta.on('end', () => {
        const bytes = Buffer.concat(partes);
        let corpo = bytes;
        if (/json/.test(String(resposta.headers['content-type']))) {
          try { corpo = JSON.parse(bytes.toString('utf8')); } catch { corpo = bytes; }
        }
        resolve({ status: resposta.statusCode, headers: resposta.headers, body: corpo });
      });
    });
    pedido.on('error', reject);
    pedido.end();
  });
  try {
    return await fn(bruto);
  } finally {
    await new Promise((resolve) => { servidor.close(() => resolve()); if (typeof servidor.closeAllConnections === 'function') servidor.closeAllConnections(); });
  }
}

describe('Biblioteca de Imagens — entrega de arquivos por HTTP (5A-1)', () => {
  let a;
  let A;
  let B;
  let master;
  let masterB;
  let soVisualizar;
  let soCriar;
  let soEditar;
  let semNada;
  let imgA;
  let imgB;
  let imgInativa;
  let padraoMin;
  let padraoCompleto;
  let padraoInativo;
  const arquivoDe = (chave) => path.join(a.raizDeImagens, ...chave.split('/'));

  before(async () => {
    a = await montarAmbienteHttpImagens({ comArmazenamento: true });
    ({ empresaA: A, empresaB: B } = a.d);
    master = a.como(a.d.master);
    masterB = a.como(a.d.masterB);
    soVisualizar = a.como(await a.usuarioCom(A, { materials: ['visualizar'] }));
    soCriar = a.como(await a.usuarioCom(A, { materials: ['criar'] }));
    soEditar = a.como(await a.usuarioCom(A, { materials: ['editar'] }));
    semNada = a.como(await a.usuarioCom(A, {}));
    imgA = await semearEmpresa(a, { empresaId: A, atorId: a.d.master, nome: 'Luva da empresa A', versao: 3 });
    imgB = await semearEmpresa(a, { empresaId: B, atorId: a.d.masterB, nome: 'Luva da empresa B' });
    imgInativa = await semearEmpresa(a, { empresaId: A, atorId: a.d.master, nome: 'Inativa da empresa A', inativar: true });
    padraoMin = await semearPadrao(a, { nome: 'Padrão só com miniatura' });
    padraoCompleto = await semearPadrao(a, { nome: 'Padrão com exibição', exibicao: webpFicticio('padrao-exi', 90) });
    padraoInativo = await semearPadrao(a, { nome: 'Padrão inativo', ativo: false });
  });
  after(async () => { if (a) await a.encerrar(); });

  describe('controles (devem passar já no RED): provam que os fixtures e o ambiente estão certos', () => {
    test('K1 — fixtures: a linha existe só na empresa dona, o arquivo está na chave derivada e o SHA-256 gravado confere com o registrado', async () => {
      const linha = await imagemEmpresaRepo.buscarPorId(a.pool, A, imgA.id);
      assert.equal(linha.sha256Miniatura, imgA.hashes.miniatura);
      assert.equal(linha.versao, 3);
      assert.equal(await imagemEmpresaRepo.buscarPorId(a.pool, B, imgA.id), null, 'outra empresa não enxerga a linha');
      for (const variante of ['miniatura', 'exibicao', 'mestre']) {
        const fluxo = await a.armazenamento.abrir(imgA.chaves[variante]);
        const partes = [];
        for await (const bloco of fluxo) partes.push(bloco);
        assert.equal(sha256Hex(Buffer.concat(partes)), imgA.hashes[variante], variante);
      }
      assert.equal((await imagemPadraoRepo.buscarPorId(a.pool, padraoMin.id)).sha256Exibicao, null);
      assert.equal((await imagemPadraoRepo.buscarPorId(a.pool, padraoCompleto.id)).sha256Exibicao, padraoCompleto.hashes.exibicao);
    });

    test('K2 — a matriz de permissões do ambiente funciona numa rota JÁ existente da biblioteca: visualizar lista (200), quem não tem nada recebe 403', async () => {
      assert.equal((await soVisualizar.get(BASE)).status, 200);
      assert.equal((await master.get(BASE)).status, 200);
      assert.equal((await semNada.get(BASE)).status, 403);
    });

    test('K3 — o armazenamento instrumentado registra cada chave pedida, e um link simbólico plantado na raiz é recusado pela camada de armazenamento (CHAVE_INVALIDA)', async () => {
      const espiao = instrumentar(a.armazenamento);
      await (await espiao.abrir(imgA.chaves.miniatura)).destroy();
      assert.deepEqual(espiao.chamadas, [{ metodo: 'abrir', chave: imgA.chaves.miniatura }]);
      const fora = criarRaizTemporaria();
      const original = arquivoDe(imgA.chaves.miniatura);
      const guardado = `${original}.guardado`;
      fs.copyFileSync(original, path.join(fora, 'copia.webp'));
      fs.renameSync(original, guardado);
      fs.symlinkSync(path.join(fora, 'copia.webp'), original);
      try {
        assert.equal(fs.lstatSync(original).isSymbolicLink(), true);
        await assert.rejects(a.armazenamento.abrir(imgA.chaves.miniatura), (falha) => falha.codigo === 'CHAVE_INVALIDA');
      } finally {
        fs.unlinkSync(original);
        fs.renameSync(guardado, original);
        removerTemporarioSeguro(fora);
      }
      await (await a.armazenamento.abrir(imgA.chaves.miniatura)).destroy();
    });
  });

  describe('[ENT] entrega efetiva, cache e condicional', () => {
    test('ENT-05 — ETag forte (o SHA-256 da VARIANTE, entre aspas, sem W/); If-None-Match que casa dá 304 sem corpo e com os mesmos ETag, Cache-Control e Vary; o que não casa dá 200', async () => {
      const alvo = url('empresa', imgA.id, 'miniatura', '?v=3');
      const r1 = await master.get(alvo);
      ok200(r1, imgA.bytes.miniatura);
      assert.equal(r1.headers.etag, `"${imgA.hashes.miniatura}"`);
      const exibicao = await master.get(url('empresa', imgA.id, 'exibicao', '?v=3'));
      ok200(exibicao, imgA.bytes.exibicao);
      assert.equal(exibicao.headers.etag, `"${imgA.hashes.exibicao}"`);
      assert.notEqual(exibicao.headers.etag, r1.headers.etag, 'cada variante tem o próprio ETag');
      const r2 = await master.get(alvo).set('If-None-Match', r1.headers.etag);
      assert.equal(r2.status, 304, aviso(r2));
      assert.equal(semCorpo(r2), true);
      for (const nome of ['etag', 'cache-control']) assert.equal(r2.headers[nome], r1.headers[nome], nome);
      assert.deepEqual(tokensDeVary(r2), tokensDeVary(r1));
      const r3 = await master.get(alvo).set('If-None-Match', '"outro-etag"');
      ok200(r3, imgA.bytes.miniatura);
      const doOutroTipo = await master.get(alvo).set('If-None-Match', exibicao.headers.etag);
      ok200(doOutroTipo, imgA.bytes.miniatura, 'o ETag de OUTRA variante não vale como condição:');
    });

    test('ENT-06 — cache privado e versionado: `v` igual à versão atual (3) é "private, max-age=31536000, immutable"; sem `v` ou com `v` diferente é "private, no-cache" com o conteúdo ATUAL; Vary: Cookie sempre', async () => {
      const certo = await master.get(url('empresa', imgA.id, 'miniatura', '?v=3'));
      ok200(certo, imgA.bytes.miniatura);
      assert.equal(certo.headers['cache-control'], 'private, max-age=31536000, immutable');
      assert.equal(tokensDeVary(certo).includes('cookie'), true);
      assert.match(certo.headers['content-type'], /^image\/webp/);
      assert.equal(certo.headers['x-content-type-options'], 'nosniff');
      assert.equal(certo.headers['set-cookie'], undefined);
      for (const sufixo of ['', '?v=2', '?v=4', '?v=1']) {
        const r = await master.get(url('empresa', imgA.id, 'miniatura', sufixo));
        ok200(r, imgA.bytes.miniatura, `${sufixo || '(sem v)'}:`);
        assert.equal(r.headers['cache-control'], 'private, no-cache', sufixo);
      }
    });

    test('ENT-07 — a query só aceita `v`: `v` inválido e qualquer outra chave são 400 VALIDACAO apontando o campo, sem ecoar o valor', async () => {
      const ancora = await master.get(url('empresa', imgA.id, 'miniatura', '?v=3'));
      ok200(ancora, imgA.bytes.miniatura);
      for (const ruim of ['?v=abc', '?v=0', '?v=-1', '?v=1.5', '?v=03', '?v=', '?v=2147483648', '?v=3&v=4']) {
        const r = await master.get(url('empresa', imgA.id, 'miniatura', ruim));
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${ruim}: ${aviso(r)}`);
        assert.equal(r.body.detalhes.some((d) => d.campo === 'query.v'), true, ruim);
      }
      for (const extra of ['?v=3&x=1', '?empresaId=2', '?usuarioId=1', '?origem=padrao']) {
        const r = await master.get(url('empresa', imgA.id, 'miniatura', extra));
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${extra}: ${aviso(r)}`);
        assert.equal(r.body.detalhes.some((d) => d.codigo === 'CAMPO_NAO_PERMITIDO'), true, extra);
      }
    });

    test('ENT-08 — HEAD: mesmos cabeçalhos do GET e nenhum corpo; 304 com If-None-Match; as recusas (401, 403, 404) também valem para HEAD', async () => {
      const alvo = url('empresa', imgA.id, 'miniatura', '?v=3');
      const get = await master.get(alvo);
      ok200(get, imgA.bytes.miniatura);
      const head = await master.head(alvo);
      assert.equal(head.status, 200, aviso(head));
      assert.equal(semCorpo(head), true);
      assert.deepEqual(cabecalhosComparaveis(head), cabecalhosComparaveis(get));
      assert.equal(Number(head.headers['content-length']), imgA.bytes.miniatura.length);
      assert.equal((await master.head(alvo).set('If-None-Match', get.headers.etag)).status, 304);
      assert.equal((await masterB.head(url('empresa', imgA.id, 'miniatura')).then((r) => r.status)), 404);
      assert.equal((await semNada.head(alvo)).status, 403);
      assert.equal((await a.como(a.d.master).head(url('empresa', '999999999999', 'miniatura'))).status, 404);
    });
  });

  describe('[ENT] 304 só depois de existência e integridade (correção V8)', () => {
    test('ENT-09 — arquivo íntegro: 304; adulterado, truncado, vazio, não-WebP ou ausente: 404 uniforme MESMO com o If-None-Match igual ao ETag do registro; recuperado o arquivo, volta o 304', async () => {
      const x = await semearEmpresa(a, { empresaId: A, atorId: a.d.master, nome: 'Condicional' });
      const alvo = url('empresa', x.id, 'miniatura');
      const arquivo = arquivoDe(x.chaves.miniatura);
      const r1 = await master.get(alvo);
      ok200(r1, x.bytes.miniatura);
      const etag = r1.headers.etag;
      assert.equal(etag, `"${x.hashes.miniatura}"`);
      assert.equal((await master.get(alvo).set('If-None-Match', etag)).status, 304, 'controle: íntegro e igual = 304');
      const mutacoes = [
        ['byte trocado', (b) => { const c = Buffer.from(b); c[c.length - 1] ^= 0xff; return c; }],
        ['truncado', (b) => b.subarray(0, Math.floor(b.length / 2))],
        ['vazio', () => Buffer.alloc(0)],
        ['não é WebP', (b) => pngFicticio('intruso', b.length)],
      ];
      for (const [nome, mutar] of mutacoes) {
        fs.writeFileSync(arquivo, mutar(x.bytes.miniatura));
        n404(await master.get(alvo).set('If-None-Match', etag), `${nome} com If-None-Match:`);
        n404(await master.get(alvo), `${nome} sem condicional:`);
        assert.equal((await master.head(alvo).set('If-None-Match', etag)).status, 404, `${nome}: HEAD com If-None-Match também é 404 (HEAD não é um oráculo mais fraco que o GET)`);
        assert.equal((await master.head(alvo)).status, 404, `${nome}: HEAD sem condicional também é 404`);
        fs.writeFileSync(arquivo, x.bytes.miniatura);
        assert.equal((await master.get(alvo).set('If-None-Match', etag)).status, 304, `recuperado após ${nome}`);
      }
      fs.unlinkSync(arquivo);
      n404(await master.get(alvo).set('If-None-Match', etag), 'ausente com If-None-Match:');
      assert.equal((await master.head(alvo).set('If-None-Match', etag)).status, 404, 'ausente: HEAD com If-None-Match também é 404');
      fs.writeFileSync(arquivo, x.bytes.miniatura);
      assert.equal((await master.get(alvo).set('If-None-Match', etag)).status, 304, 'recuperado após ausência');
    });

    test('ENT-10 — o ETag do registro também não vale para imagem inativa, de outra empresa ou inexistente: 404 uniforme, nunca 304', async () => {
      const x = await semearEmpresa(a, { empresaId: A, atorId: a.d.master, nome: 'Será inativada' });
      const alvo = url('empresa', x.id, 'miniatura');
      const ancora = await master.get(alvo);
      ok200(ancora, x.bytes.miniatura, 'âncora:');
      const etag = ancora.headers.etag;
      assert.equal(etag, `"${x.hashes.miniatura}"`);
      n404(await masterB.get(alvo).set('If-None-Match', etag), 'outra empresa:');
      n404(await master.get(url('empresa', '999999999999', 'miniatura')).set('If-None-Match', etag), 'inexistente:');
      await servico.inativar(a.pool, { empresaId: A, atorId: a.d.master, imagemId: x.id });
      n404(await master.get(alvo).set('If-None-Match', etag), 'inativa:');
    });
  });

  describe('[ENT] isolamento e uniformidade', () => {
    test('ENT-11 — enumeração: todo id que não é imagem ATIVA da empresa (de outra empresa, inativa, inexistente) responde o MESMO 404 (status, corpo e cabeçalhos); as imagens da empresa continuam 200', async () => {
      ok200(await master.get(url('empresa', imgA.id, 'miniatura')), imgA.bytes.miniatura, 'âncora:');
      // Outros testes deste arquivo criam imagens ATIVAS na empresa A (e corrompem os arquivos delas): essas não entram na comparação.
      // Aqui valem só os ids que NÃO são imagem ativa da empresa A: de outra empresa, inativos ou inexistentes.
      const ativasDeA = new Set((await a.q("SELECT id::text AS id FROM imagens_empresa WHERE empresa_id = $1 AND estado = 'ATIVA'", [A])).rows.map((l) => l.id));
      const maior = Number((await a.q('SELECT max(id) AS maior FROM imagens_empresa')).rows[0].maior) + 6;
      const referencia = await master.get(url('empresa', '999999999999', 'miniatura'));
      n404(referencia, 'referência:');
      const recusados = [];
      for (let id = 1; id <= maior; id += 1) {
        const r = await master.get(url('empresa', String(id), 'miniatura'));
        if (String(id) === imgA.id) { ok200(r, imgA.bytes.miniatura, `id ${id}:`); continue; }
        if (ativasDeA.has(String(id))) continue;
        n404(r, `id ${id}:`);
        assert.deepEqual(r.body, referencia.body, `id ${id}`);
        assert.deepEqual(cabecalhosComparaveis(r), cabecalhosComparaveis(referencia), `cabeçalhos do id ${id}`);
        recusados.push(String(id));
      }
      for (const [nome, id] of [['imagem de outra empresa', imgB.id], ['imagem inativa da própria empresa', imgInativa.id]]) assert.equal(recusados.includes(id), true, `${nome} (id ${id}) foi comparada`);
    });

    test('ENT-12 — duas empresas com o MESMO conteúdo (mesmos hashes) têm arquivos físicos distintos: A nunca lê o arquivo de B, e adulterar o de B não afeta A', async () => {
      const miniatura = webpFicticio('igual-min', 52);
      const exibicao = webpFicticio('igual-exi', 77);
      const mestre = pngFicticio('igual-mes', 150);
      const iA = await semearEmpresa(a, { empresaId: A, atorId: a.d.master, nome: 'Igual em A', miniatura, exibicao, mestre });
      const iB = await semearEmpresa(a, { empresaId: B, atorId: a.d.masterB, nome: 'Igual em B', miniatura, exibicao, mestre });
      assert.equal(iA.hashes.miniatura, iB.hashes.miniatura, 'mesmo conteúdo, mesmos hashes');
      assert.notEqual(iA.chaves.miniatura, iB.chaves.miniatura, 'arquivos físicos distintos por empresa');
      ok200(await master.get(url('empresa', iA.id, 'miniatura')), miniatura, 'A lê o seu:');
      ok200(await masterB.get(url('empresa', iB.id, 'miniatura')), miniatura, 'B lê o seu:');
      n404(await master.get(url('empresa', iB.id, 'miniatura')), 'A pede o id de B:');
      n404(await masterB.get(url('empresa', iA.id, 'miniatura')), 'B pede o id de A:');
      fs.writeFileSync(arquivoDe(iB.chaves.miniatura), webpFicticio('adulterado-em-b', 52));
      n404(await masterB.get(url('empresa', iB.id, 'miniatura')), 'B com o arquivo adulterado:');
      ok200(await master.get(url('empresa', iA.id, 'miniatura')), miniatura, 'A segue íntegro:');
    });

    test('ENT-13 — biblioteca PADRÃO: qualquer empresa com materials.visualizar lê a miniatura (os mesmos bytes); sem exibição registrada é 404; com exibição é 200; padrão inativa é 404; origem e id são um par (sem mistura entre bibliotecas)', async () => {
      ok200(await master.get(url('padrao', padraoMin.id, 'miniatura')), padraoMin.bytes.miniatura, 'A:');
      ok200(await masterB.get(url('padrao', padraoMin.id, 'miniatura')), padraoMin.bytes.miniatura, 'B:');
      n404(await master.get(url('padrao', padraoMin.id, 'exibicao')), 'exibição ainda não existente:');
      ok200(await master.get(url('padrao', padraoCompleto.id, 'exibicao')), padraoCompleto.bytes.exibicao, 'exibição registrada:');
      ok200(await master.get(url('padrao', padraoCompleto.id, 'miniatura')), padraoCompleto.bytes.miniatura, 'miniatura do completo:');
      n404(await master.get(url('padrao', padraoInativo.id, 'miniatura')), 'padrão inativa:');
      // Imagens ativas criadas por outros testes deste arquivo não entram na comparação; só ids que não pertencem à biblioteca consultada.
      const ativasDeA = new Set((await a.q("SELECT id::text AS id FROM imagens_empresa WHERE empresa_id = $1 AND estado = 'ATIVA'", [A])).rows.map((l) => l.id));
      const padroesAtivos = new Set((await a.q('SELECT id::text AS id FROM imagens_padrao WHERE ativo')).rows.map((l) => l.id));
      const dosPadroes = new Map([[padraoMin.id, padraoMin.bytes.miniatura], [padraoCompleto.id, padraoCompleto.bytes.miniatura]]);
      const maior = Math.max(
        Number((await a.q('SELECT max(id) AS maior FROM imagens_empresa')).rows[0].maior),
        Number((await a.q('SELECT max(id) AS maior FROM imagens_padrao')).rows[0].maior),
      ) + 3;
      let separados = 0;
      for (let id = 1; id <= maior; id += 1) {
        const empresa = await master.get(url('empresa', String(id), 'miniatura'));
        if (String(id) === imgA.id) ok200(empresa, imgA.bytes.miniatura, `empresa ${id}:`);
        else if (!ativasDeA.has(String(id))) n404(empresa, `empresa ${id}:`);
        const padrao = await master.get(url('padrao', String(id), 'miniatura'));
        if (dosPadroes.has(String(id))) ok200(padrao, dosPadroes.get(String(id)), `padrão ${id}:`);
        else if (!padroesAtivos.has(String(id))) n404(padrao, `padrão ${id}:`);
        // Sem mistura: o id de uma biblioteca nunca abre a outra (um id só da padrão é 404 como "empresa" e vice-versa).
        if (dosPadroes.has(String(id)) && String(id) !== imgA.id && !ativasDeA.has(String(id))) { n404(empresa, `id ${id} da padrão pedido como empresa:`); separados += 1; }
      }
      assert.equal(separados >= 1, true, 'ao menos um id exclusivo da biblioteca padrão foi pedido como empresa');
    });

    test('ENT-14 — a autoridade só vem da sessão: chaves de empresa/usuário na query são 400; cabeçalhos x-empresa-id/x-usuario-id/Authorization/Cookie do cliente são ignorados', async () => {
      ok200(await master.get(url('empresa', imgA.id, 'miniatura')), imgA.bytes.miniatura, 'âncora:');
      for (const extra of [`?empresaId=${B}`, `?usuarioId=${a.d.masterB}`, `?empresa_id=${B}`]) {
        const r = await master.get(url('empresa', imgA.id, 'miniatura', extra));
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `${extra}: ${aviso(r)}`);
      }
      const falsos = { 'x-empresa-id': String(B), 'x-usuario-id': String(a.d.masterB), Authorization: 'Bearer forjado', Cookie: 'gepi_sessao=forjado' };
      let pedido = master.get(url('empresa', imgB.id, 'miniatura'));
      for (const [nome, valor] of Object.entries(falsos)) pedido = pedido.set(nome, valor);
      n404(await pedido, 'o id de B pedido por A com cabeçalhos de B:');
      let proprio = master.get(url('empresa', imgA.id, 'miniatura'));
      for (const [nome, valor] of Object.entries(falsos)) proprio = proprio.set(nome, valor);
      ok200(await proprio, imgA.bytes.miniatura, 'o próprio id com cabeçalhos falsos:');
    });
  });

  describe('[ENT] sessão, permissão e ordem das verificações', () => {
    test('ENT-15 — sem sessão: 401 (decidido antes de validar id, `v` e query); com o middleware de sessão REAL e sem cookie: 401 SESSAO_INVALIDA', async () => {
      const real = a.appDeEntrega({ exigirSessao: criarExigirSessao({ pool: a.pool }) });
      for (const alvo of [url('empresa', imgA.id, 'miniatura'), url('empresa', '05', 'miniatura'), url('empresa', imgA.id, 'miniatura', '?v=abc'), url('x', 'y', 'z')]) {
        const semSessao = await request(a.app).get(alvo);
        assert.equal(semSessao.status, 401, `${alvo}: ${aviso(semSessao)}`);
        const comReal = await request(real).get(alvo);
        assert.deepEqual([comReal.status, comReal.body.codigo], [401, 'SESSAO_INVALIDA'], `${alvo}: ${aviso(comReal)}`);
      }
    });

    test('ENT-16 — permissão: só materials.visualizar entrega (MASTER também); criar, editar ou nada dão 403 PERMISSAO_NEGADA, decidido ANTES da validação (id inválido, `v` inválido e origem desconhecida não viram 400/404)', async () => {
      const alvo = url('empresa', imgA.id, 'miniatura');
      ok200(await soVisualizar.get(alvo), imgA.bytes.miniatura, 'visualizar:');
      ok200(await master.get(alvo), imgA.bytes.miniatura, 'MASTER:');
      for (const [nome, quem] of [['só criar', soCriar], ['só editar', soEditar], ['nada', semNada]]) {
        for (const pedido of [alvo, url('empresa', '05', 'miniatura'), url('empresa', imgA.id, 'miniatura', '?v=abc'), url('x', imgA.id, 'y')]) {
          const r = await quem.get(pedido);
          assert.deepEqual([r.status, r.body.codigo], [403, 'PERMISSAO_NEGADA'], `${nome} ${pedido}: ${aviso(r)}`);
        }
      }
      const invalido = await soVisualizar.get(url('empresa', '05', 'miniatura'));
      assert.deepEqual([invalido.status, invalido.body.codigo], [400, 'VALIDACAO'], aviso(invalido));
      assert.equal(invalido.body.detalhes.some((d) => d.campo === 'params.id' && d.codigo === 'ID_INVALIDO'), true);
    });
  });

  describe('[ENT] nada do cliente chega ao sistema de arquivos', () => {
    test('ENT-17 — parâmetros forjados (travessia, codificação, NUL, "mestre", maiúsculas, extensão, texto enorme): origem/variante desconhecidas são 404 uniforme, id fora do formato é 400, e o armazenamento NUNCA é tocado por eles', async () => {
      const espiao = instrumentar(a.armazenamento);
      const app = a.appDeEntrega({ armazenamento: espiao });
      const variantes = ['..', '%2e%2e', '..%2f..%2f..%2fetc%2fpasswd', '%2e%2e%2f%2e%2e%2fetc%2fpasswd', 'mestre', 'MINIATURA', 'Miniatura', 'miniatura.webp', 'miniatura%00', 'miniatura%20', 'original', 'x'.repeat(3000), '%E2%80%8Bminiatura', 'miniatura%2f..', 'mestre.png'];
      const origens = ['EMPRESA', 'Padrao', '..', '%2e%2e', 'empresa%2f..', 'padrao%00', 'x'.repeat(3000), '%2e%2e%2f', 'empresa%20'];
      const ids = ['05', 'abc', '0', '-1', '1.5', '1e3', '%2e%2e', '1%2f..%2f..%2fetc', '0x1', '1;rm', '+1', '%20', '%EF%BC%91', '9223372036854775808'];
      await comPedidosCrus(app, a.d.master, async (bruto) => {
        ok200(await bruto(url('empresa', imgA.id, 'miniatura')), imgA.bytes.miniatura, 'âncora (pedido cru):');
        assert.deepEqual(espiao.chamadas.map((c) => c.chave), [imgA.chaves.miniatura], 'a ÚNICA chave pedida é a derivada do banco');
        espiao.chamadas.length = 0;
        for (const v of variantes) n404(await bruto(url('empresa', imgA.id, v)), `variante ${v.slice(0, 40)}:`);
        for (const o of origens) n404(await bruto(url(o, imgA.id, 'miniatura')), `origem ${o.slice(0, 40)}:`);
        for (const i of ids) {
          const r = await bruto(url('empresa', i, 'miniatura'));
          assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], `id ${i}: ${aviso(r)}`);
        }
      });
      assert.deepEqual(espiao.chamadas, [], 'nenhuma chave foi pedida ao armazenamento por entrada forjada');
    });

    test('ENT-18 — link simbólico no armazenamento (arquivo, pasta da imagem, pasta da empresa, pasta padrão) nunca é seguido: 404 uniforme mesmo quando o alvo de fora tem os MESMOS bytes e o SHA-256 confere', async () => {
      const fora = criarRaizTemporaria();
      try {
        // (a) o arquivo vira link para uma cópia de fora
        const xa = await semearEmpresa(a, { empresaId: A, atorId: a.d.master, nome: 'Link no arquivo' });
        const arquivo = arquivoDe(xa.chaves.miniatura);
        ok200(await master.get(url('empresa', xa.id, 'miniatura')), xa.bytes.miniatura, '(a) antes:');
        fs.copyFileSync(arquivo, path.join(fora, 'copia-a.webp'));
        fs.renameSync(arquivo, `${arquivo}.guardado`);
        fs.symlinkSync(path.join(fora, 'copia-a.webp'), arquivo);
        n404(await master.get(url('empresa', xa.id, 'miniatura')), '(a) link no arquivo:');
        fs.unlinkSync(arquivo);
        fs.renameSync(`${arquivo}.guardado`, arquivo);
        ok200(await master.get(url('empresa', xa.id, 'miniatura')), xa.bytes.miniatura, '(a) restaurado:');

        // (b) a pasta da imagem vira link para uma cópia de fora
        const xb = await semearEmpresa(a, { empresaId: A, atorId: a.d.master, nome: 'Link na pasta da imagem' });
        const pastaB = path.dirname(arquivoDe(xb.chaves.miniatura));
        fs.cpSync(pastaB, path.join(fora, 'copia-b'), { recursive: true });
        fs.renameSync(pastaB, `${pastaB}.guardada`);
        fs.symlinkSync(path.join(fora, 'copia-b'), pastaB);
        n404(await master.get(url('empresa', xb.id, 'miniatura')), '(b) link na pasta da imagem:');
        fs.unlinkSync(pastaB);
        fs.renameSync(`${pastaB}.guardada`, pastaB);
        ok200(await master.get(url('empresa', xb.id, 'miniatura')), xb.bytes.miniatura, '(b) restaurado:');

        // (c) a pasta da empresa B vira link para uma cópia de fora (A não é afetada)
        const pastaEmpresa = path.join(a.raizDeImagens, String(B));
        ok200(await masterB.get(url('empresa', imgB.id, 'miniatura')), imgB.bytes.miniatura, '(c) antes:');
        fs.cpSync(pastaEmpresa, path.join(fora, 'copia-c'), { recursive: true });
        fs.renameSync(pastaEmpresa, `${pastaEmpresa}.guardada`);
        fs.symlinkSync(path.join(fora, 'copia-c'), pastaEmpresa);
        n404(await masterB.get(url('empresa', imgB.id, 'miniatura')), '(c) link na pasta da empresa:');
        ok200(await master.get(url('empresa', imgA.id, 'miniatura')), imgA.bytes.miniatura, '(c) a empresa A não é afetada:');
        fs.unlinkSync(pastaEmpresa);
        fs.renameSync(`${pastaEmpresa}.guardada`, pastaEmpresa);
        ok200(await masterB.get(url('empresa', imgB.id, 'miniatura')), imgB.bytes.miniatura, '(c) restaurado:');

        // (d) a pasta padrao vira link para uma cópia de fora
        const pastaPadrao = path.join(a.raizDeImagens, 'padrao');
        ok200(await master.get(url('padrao', padraoMin.id, 'miniatura')), padraoMin.bytes.miniatura, '(d) antes:');
        fs.cpSync(pastaPadrao, path.join(fora, 'copia-d'), { recursive: true });
        fs.renameSync(pastaPadrao, `${pastaPadrao}.guardada`);
        fs.symlinkSync(path.join(fora, 'copia-d'), pastaPadrao);
        n404(await master.get(url('padrao', padraoMin.id, 'miniatura')), '(d) link na pasta padrao:');
        fs.unlinkSync(pastaPadrao);
        fs.renameSync(`${pastaPadrao}.guardada`, pastaPadrao);
        ok200(await master.get(url('padrao', padraoMin.id, 'miniatura')), padraoMin.bytes.miniatura, '(d) restaurado:');
      } finally {
        removerTemporarioSeguro(fora);
      }
    });
  });

  describe('[ENT] integridade, tamanho e arquivo ausente', () => {
    test('ENT-19 — arquivo adulterado, truncado, com bytes extras, vazio ou substituído por outro conteúdo: 404 uniforme e nenhum byte; só a variante comprometida é afetada (a outra continua 200)', async () => {
      const casos = [
        ['byte trocado', (b) => { const c = Buffer.from(b); c[c.length - 1] ^= 0xff; return c; }],
        ['truncado', (b) => b.subarray(0, Math.floor(b.length / 2))],
        ['bytes extras no fim', (b) => Buffer.concat([b, Buffer.from('lixo-no-fim')])],
        ['vazio', () => Buffer.alloc(0)],
        ['outro WebP válido (hash diferente)', () => webpFicticio('intruso', 48)],
      ];
      for (const [nome, mutar] of casos) {
        const x = await semearEmpresa(a, { empresaId: A, atorId: a.d.master, nome: `Integridade ${nome}` });
        ok200(await master.get(url('empresa', x.id, 'miniatura')), x.bytes.miniatura, `${nome}, antes:`);
        fs.writeFileSync(arquivoDe(x.chaves.miniatura), mutar(x.bytes.miniatura));
        n404(await master.get(url('empresa', x.id, 'miniatura')), `${nome}:`);
        ok200(await master.get(url('empresa', x.id, 'exibicao')), x.bytes.exibicao, `${nome}, a exibição intacta:`);
      }
      const p = await semearPadrao(a, { nome: 'Padrão adulterado' });
      ok200(await master.get(url('padrao', p.id, 'miniatura')), p.bytes.miniatura, 'padrão, antes:');
      fs.writeFileSync(arquivoDe(p.chaves.miniatura), webpFicticio('intruso-padrao', 40));
      n404(await master.get(url('padrao', p.id, 'miniatura')), 'padrão adulterado:');
    });

    test('ENT-20 — conteúdo que NÃO é WebP (com o SHA-256 registrado coerente) e arquivo acima do teto de leitura não são entregues como image/webp', async () => {
      const naoWebp = await semearEmpresa(a, { empresaId: A, atorId: a.d.master, nome: 'Não é WebP', miniatura: pngFicticio('so-parece-miniatura', 60) });
      n404(await master.get(url('empresa', naoWebp.id, 'miniatura')), 'PNG no lugar do WebP:');
      ok200(await master.get(url('empresa', naoWebp.id, 'exibicao')), naoWebp.bytes.exibicao, 'a exibição desta imagem é WebP:');
      const enorme = await semearEmpresa(a, { empresaId: A, atorId: a.d.master, nome: 'Acima do teto', miniatura: webpFicticio('enorme', 2 * 1024 * 1024 + 1) });
      n404(await master.get(url('empresa', enorme.id, 'miniatura')), 'acima do teto:');
      ok200(await master.get(url('empresa', enorme.id, 'exibicao')), enorme.bytes.exibicao, 'a exibição desta imagem cabe no teto:');
    });

    test('ENT-21 — arquivo ausente: 404 indistinguível (corpo e cabeçalhos) de id inexistente; registro técnico só com ids e motivo — sem caminho, chave, hash nem nome de arquivo', async (t) => {
      const x = await semearEmpresa(a, { empresaId: A, atorId: a.d.master, nome: 'Arquivo sumiu' });
      ok200(await master.get(url('empresa', x.id, 'miniatura')), x.bytes.miniatura, 'antes:');
      fs.unlinkSync(arquivoDe(x.chaves.miniatura));
      const erros = capturarErros(t);
      const ausente = await master.get(url('empresa', x.id, 'miniatura'));
      const inexistente = await master.get(url('empresa', '999999999999', 'miniatura'));
      n404(ausente, 'arquivo ausente:');
      n404(inexistente, 'inexistente:');
      assert.deepEqual(ausente.body, inexistente.body);
      assert.deepEqual(cabecalhosComparaveis(ausente), cabecalhosComparaveis(inexistente));
      const texto = erros.texto();
      assert.equal(erros.chamadas().length >= 1, true, 'a ausência é registrada para a operação');
      assert.match(texto, /ARQUIVO_AUSENTE/);
      assert.equal(texto.includes(a.raizDeImagens), false, 'caminho do diretório');
      assert.equal(texto.includes(path.basename(a.raizDeImagens)), false, 'nome do diretório temporário');
      assert.doesNotMatch(texto, /[0-9a-f]{64}/, 'hash ou chave');
      assert.doesNotMatch(texto, /\.webp|\.png|\/imagens|miniatura\./);
    });
  });

  describe('[ENT] indisponibilidade e falhas do armazenamento', () => {
    test('ENT-22 — sem armazenamento configurado: 503 IMAGENS_INDISPONIVEL para todo pedido de formato válido (existente, inexistente, de outra empresa, origem/variante desconhecidas) e NENHUMA consulta a imagens; antes dele valem 401, 403 e 400', async (t) => {
      // O espião enxerga TODA consulta do pool: as feitas por `pool.query` e as dos clientes entregues por `pool.connect()` (a listagem usa transação).
      const consultas = [];
      const registrar = (consulta) => consultas.push(typeof consulta === 'string' ? consulta : String(consulta?.text ?? ''));
      const envolver = (cliente) => new Proxy(cliente, {
        get(alvoDoProxy, propriedade) {
          if (propriedade === 'query') return (...consulta) => { registrar(consulta[0]); return alvoDoProxy.query(...consulta); };
          const valor = alvoDoProxy[propriedade];
          return typeof valor === 'function' ? valor.bind(alvoDoProxy) : valor;
        },
      });
      const consultaOriginal = a.pool.query.bind(a.pool);
      const conectarOriginal = a.pool.connect.bind(a.pool);
      const espiao = t.mock.method(a.pool, 'query', async (...argumentos) => { registrar(argumentos[0]); return consultaOriginal(...argumentos); });
      t.mock.method(a.pool, 'connect', (...argumentos) => {
        // `pool.query` chama `connect(callback)` por dentro: o uso com callback passa direto (a consulta já foi registrada por `pool.query`).
        if (typeof argumentos[0] === 'function') return conectarOriginal(...argumentos);
        return conectarOriginal(...argumentos).then(envolver);
      });
      const buscaEmpresa = t.mock.method(imagemEmpresaRepo, 'buscarPorId');
      const buscaPadrao = t.mock.method(imagemPadraoRepo, 'buscarPorId');
      const comAmbiente = await master.get(BASE);
      assert.equal(comAmbiente.status, 200, 'controle: a listagem (rota existente) consulta as tabelas de imagens');
      assert.equal(consultas.some((sql) => /imagens_(empresa|padrao)/.test(sql)), true, 'controle: o espião enxerga consultas a imagens');
      consultas.length = 0;
      buscaEmpresa.mock.resetCalls();
      buscaPadrao.mock.resetCalls();
      const app = a.appDeEntrega({ armazenamento: null });
      const como = (id) => a.como(id, app);
      const pedidos = [url('empresa', imgA.id, 'miniatura'), url('empresa', '999999999999', 'miniatura'), url('empresa', imgB.id, 'miniatura'), url('padrao', padraoMin.id, 'miniatura'), url('x', imgA.id, 'y')];
      for (const pedido of pedidos) {
        const r = await como(a.d.master).get(pedido);
        assert.deepEqual([r.status, r.body.codigo], [503, 'IMAGENS_INDISPONIVEL'], `${pedido}: ${aviso(r)}`);
        assert.doesNotMatch(String(r.headers['cache-control'] ?? ''), /private|immutable|max-age/, `${pedido}: o erro não leva a política de cache da imagem`);
        assert.doesNotMatch(String(r.headers.etag ?? ''), /[0-9a-f]{64}/, `${pedido}: o erro não leva o ETag da imagem (o ETag fraco automático do JSON é outra coisa)`);
      }
      assert.equal((await como(a.d.master).head(pedidos[0])).status, 503);
      assert.equal(espiao.mock.calls.length >= 1, true);
      assert.equal(consultas.some((sql) => /imagens_(empresa|padrao)/.test(sql)), false, 'nenhuma consulta às tabelas de imagens');
      assert.equal(buscaEmpresa.mock.callCount() + buscaPadrao.mock.callCount(), 0, 'nenhuma busca de imagem');
      assert.equal((await request(app).get(pedidos[0])).status, 401, 'sem sessão: 401 antes do 503');
      const proibido = await a.como(await a.usuarioCom(A, {}), app).get(pedidos[0]);
      assert.deepEqual([proibido.status, proibido.body.codigo], [403, 'PERMISSAO_NEGADA']);
      const invalido = await como(a.d.master).get(url('empresa', '05', 'miniatura'));
      assert.deepEqual([invalido.status, invalido.body.codigo], [400, 'VALIDACAO'], 'id inválido: 400 antes do 503');
    });

    test('ENT-23 — falha de E/S do armazenamento (erro cru com caminho na mensagem ou ARMAZENAMENTO_FALHOU): 500 com a mensagem genérica do projeto, sem caminho, sem texto do erro e sem 404 (não é "imagem não encontrada"), nem na resposta nem nos registros', async (t) => {
      ok200(await master.get(url('empresa', imgA.id, 'miniatura')), imgA.bytes.miniatura, 'âncora:');
      for (const falha of [
        Object.assign(new Error(`EACCES: permission denied, open '${arquivoDe(imgA.chaves.miniatura)}'`), { code: 'EACCES' }),
        Object.assign(new Error('falha no armazenamento de imagens'), { codigo: 'ARMAZENAMENTO_FALHOU' }),
      ]) {
        const quebrado = { ...a.armazenamento, abrir: async () => { throw falha; }, existe: async () => { throw falha; } };
        const erros = capturarErros(t);
        const r = await a.como(a.d.master, a.appDeEntrega({ armazenamento: quebrado })).get(url('empresa', imgA.id, 'miniatura'));
        assert.equal(r.status, 500, aviso(r));
        assert.equal(r.body.message, 'Erro interno do servidor', aviso(r));
        assert.match(String(r.body.codigo), /^[A-Z][A-Z0-9_]*$/, aviso(r));
        assert.notEqual(r.body.codigo, 'IMAGEM_NAO_ENCONTRADA', 'falha de armazenamento não se disfarça de ausência');
        assert.doesNotMatch(JSON.stringify(r.body), /EACCES|permission denied|falha no armazenamento/i, 'o texto do erro não sai na resposta');
        assert.equal(JSON.stringify(r.body).includes(a.raizDeImagens), false);
        assert.equal(erros.texto().includes(a.raizDeImagens), false, 'nenhum caminho nos registros técnicos');
        t.mock.restoreAll();
      }
    });

    test('ENT-24 — fiação pelo AMBIENTE (sem injetar nada, como em produção): sem IMAGENS_ARMAZENAMENTO_DIRETORIO a entrega é 503 IMAGENS_INDISPONIVEL; com o diretório configurado a mesma imagem sai 200; diretório inválido impede a montagem', async () => {
      const alvoDaImagem = url('empresa', imgA.id, 'miniatura');
      await comAmbiente({ IMAGENS_ARMAZENAMENTO_DIRETORIO: undefined }, async () => {
        const r = await a.como(a.d.master, a.appDoAmbiente()).get(alvoDaImagem);
        assert.deepEqual([r.status, r.body.codigo], [503, 'IMAGENS_INDISPONIVEL'], `sem diretório: ${aviso(r)}`);
      });
      await comAmbiente({ IMAGENS_ARMAZENAMENTO_DIRETORIO: a.raizDeImagens }, async () => {
        const r = await a.como(a.d.master, a.appDoAmbiente()).get(alvoDaImagem);
        ok200(r, imgA.bytes.miniatura, 'diretório do ambiente:');
        assert.equal(r.headers.etag, `"${imgA.hashes.miniatura}"`);
      });
      await comAmbiente({ IMAGENS_ARMAZENAMENTO_DIRETORIO: 'relativo/imagens-xyz-417' }, async () => {
        assert.throws(
          () => a.appDoAmbiente(),
          (falha) => falha.codigo === 'IMAGENS_DIRETORIO_INVALIDO' && !falha.message.includes('imagens-xyz-417'),
          'diretório inválido deveria impedir a montagem (ainda não implementado)',
        );
      });
    });

    test('ENT-25 — rajada: 40 pedidos simultâneos (miniaturas e exibições, empresa e padrão) respondem 200 com os bytes certos de cada um', async () => {
      const alvos = [
        [url('empresa', imgA.id, 'miniatura'), imgA.bytes.miniatura], [url('empresa', imgA.id, 'exibicao'), imgA.bytes.exibicao],
        [url('padrao', padraoMin.id, 'miniatura'), padraoMin.bytes.miniatura], [url('padrao', padraoCompleto.id, 'exibicao'), padraoCompleto.bytes.exibicao],
      ];
      const respostas = await Promise.all(Array.from({ length: 40 }, (_, i) => master.get(alvos[i % alvos.length][0]).then((r) => [r, alvos[i % alvos.length][1]])));
      for (const [r, bytes] of respostas) ok200(r, bytes, 'rajada:');
    });
  });
});
