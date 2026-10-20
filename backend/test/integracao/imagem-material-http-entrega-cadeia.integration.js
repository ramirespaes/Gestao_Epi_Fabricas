'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const { montarAmbienteHttpImagens } = require('./helpers/imagem-material-http');
const { CABECALHO } = require('./helpers/ambiente-http-12d2');
const {
  semearEmpresa, semearPadrao, tokensDeVary, cabecalhosComparaveis, comAmbiente,
} = require('./helpers/imagem-material-entrega');

/**
 * Biblioteca de Imagens, Unidade 5A-1 (RED) — a ENTREGA de arquivos atravessando a CADEIA DE PRODUÇÃO (os mesmos componentes de app.js: Helmet,
 * CORS da API, `Cache-Control: no-store` global, verificação de origem, política de conteúdo, 404 e tratamento de erro), com PostgreSQL real em
 * schema temporário, armazenamento real em diretório temporário exclusivo e a sessão de teste por cabeçalho. O limite de taxa NÃO entra aqui: o
 * de app.js é provado no app real (app-imagem-material-limite*.test.js).
 *
 * O que só a cadeia prova (o mini-app dos demais testes não tem Helmet, CORS nem o `no-store` global):
 *   - a entrega SUBSTITUI o `no-store` global por `private` (imutável só com `v` = versão atual) e só nas respostas 200 e 304; toda recusa continua
 *     `no-store`, sem ETag e sem tipo de imagem;
 *   - `Vary` acumula `Origin` (do CORS) e `Cookie` (da entrega), sem perder nenhum; CORS devolve a origem EXATA com credentials, nunca `*`;
 *   - a política `Cross-Origin-Resource-Policy` é `same-origin` (Helmet) em tudo; a imagem 200/304 usa a da configuração — `same-origin` por padrão e
 *     em produção, `same-site` só no desenvolvimento local, nunca em produção; o Helmet global não é afrouxado para as demais rotas;
 *   - os demais cabeçalhos de segurança do Helmet permanecem; nenhuma resposta traz Set-Cookie.
 */

const BASE = '/api/imagens-material';
const alvo = (origem, id, variante, query = '') => `${BASE}/${origem}/${id}/${variante}${query}`;
const aviso = (r) => `${r.status} ${Buffer.isBuffer(r.body) ? `<${r.body.length} bytes ${r.headers['content-type'] ?? ''}>` : JSON.stringify(r.body)}`;
const cabecalhosCors = (r) => Object.keys(r.headers).filter((nome) => nome.startsWith('access-control-'));

describe('Biblioteca de Imagens — entrega de arquivos na cadeia de produção (5A-1)', () => {
  let a;
  let master;
  let masterB;
  let semNada;
  let img;
  let padrao;
  let cadeia;
  let cadeiaSameSite;
  let cadeiaSemArmazenamento;

  before(async () => {
    a = await montarAmbienteHttpImagens({ comArmazenamento: true });
    master = a.d.master;
    masterB = a.d.masterB;
    semNada = await a.usuarioCom(a.d.empresaA, {});
    img = await semearEmpresa(a, { empresaId: a.d.empresaA, atorId: a.d.master, nome: 'Luva da cadeia', versao: 5 });
    padrao = await semearPadrao(a, { nome: 'Padrão da cadeia' });
    cadeia = a.cadeiaDeProducao();
    cadeiaSameSite = a.cadeiaDeProducao({ corp: 'same-site' });
    cadeiaSemArmazenamento = a.cadeiaDeProducao({ armazenamento: null });
  });
  after(async () => { if (a) await a.encerrar(); });

  const pedir = (app, usuario, caminho, { origem = a.ORIGEM_PERMITIDA, condicional = null, metodo = 'get' } = {}) => {
    let pedido = request(app)[metodo](caminho);
    if (usuario !== null) pedido = pedido.set(CABECALHO, String(usuario));
    if (origem !== null) pedido = pedido.set('Origin', origem);
    if (condicional !== null) pedido = pedido.set('If-None-Match', condicional);
    return pedido;
  };
  const ok = (r, bytes, onde = '') => {
    assert.equal(r.status, 200, `${onde} ${aviso(r)}`);
    assert.deepEqual(r.body, bytes, `${onde} os bytes entregues não são os gravados`);
  };
  const helmetIntacto = (r, onde = '') => {
    assert.equal(r.headers['x-frame-options'], 'DENY', `${onde} x-frame-options`);
    assert.equal(r.headers['referrer-policy'], 'no-referrer', `${onde} referrer-policy`);
    assert.equal(r.headers['cross-origin-opener-policy'], 'same-origin', `${onde} cross-origin-opener-policy`);
    assert.match(String(r.headers['content-security-policy']), /default-src 'none'/, `${onde} content-security-policy`);
    assert.equal(r.headers['x-powered-by'], undefined, `${onde} x-powered-by`);
  };
  const semCoringa = (r, onde = '') => assert.notEqual(r.headers['access-control-allow-origin'], '*', `${onde} CORS nunca "*"`);

  describe('[CAD] resposta 200 e 304 na cadeia real', () => {
    test('CAD-01 — 200: a entrega substitui o `no-store` global por cache privado versionado, mantém nosniff, ETag forte, CORP same-origin, CORS exato com credentials, Vary com Origin e Cookie, os cabeçalhos do Helmet e nenhum Set-Cookie — em empresa e padrão, miniatura e exibição', async () => {
      const casos = [
        ['empresa miniatura', alvo('empresa', img.id, 'miniatura', `?v=${img.versao}`), img.bytes.miniatura, img.hashes.miniatura],
        ['empresa exibição', alvo('empresa', img.id, 'exibicao', `?v=${img.versao}`), img.bytes.exibicao, img.hashes.exibicao],
        ['padrão miniatura', alvo('padrao', padrao.id, 'miniatura', `?v=${padrao.versao}`), padrao.bytes.miniatura, padrao.hashes.miniatura],
      ];
      for (const [nome, caminho, bytes, hash] of casos) {
        const r = await pedir(cadeia, master, caminho);
        ok(r, bytes, `${nome}:`);
        assert.equal(r.headers['cache-control'], 'private, max-age=31536000, immutable', `${nome}: a entrega substitui o no-store global (e não o acrescenta)`);
        assert.match(r.headers['content-type'], /^image\/webp/, nome);
        assert.equal(r.headers['x-content-type-options'], 'nosniff', nome);
        assert.equal(r.headers.etag, `"${hash}"`, nome);
        assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin', nome);
        assert.equal(r.headers['access-control-allow-origin'], a.ORIGEM_PERMITIDA, `${nome}: origem exata`);
        assert.equal(r.headers['access-control-allow-credentials'], 'true', nome);
        semCoringa(r, nome);
        assert.deepEqual(tokensDeVary(r), ['cookie', 'origin'], `${nome}: Vary acumula Origin (CORS) e Cookie (entrega)`);
        assert.equal(r.headers['set-cookie'], undefined, `${nome}: a entrega nunca define cookie`);
        assert.equal(Number(r.headers['content-length']), bytes.length, nome);
        helmetIntacto(r, `${nome}:`);
      }
    });

    test('CAD-02 — `v` ausente ou diferente da versão atual: continua 200 com o conteúdo atual, mas só `private, no-cache` (nunca o no-store global, nunca imutável), com os mesmos ETag e Vary', async () => {
      const referencia = await pedir(cadeia, master, alvo('empresa', img.id, 'miniatura', `?v=${img.versao}`));
      ok(referencia, img.bytes.miniatura, 'âncora:');
      for (const sufixo of ['', '?v=1', `?v=${img.versao + 1}`]) {
        const r = await pedir(cadeia, master, alvo('empresa', img.id, 'miniatura', sufixo));
        ok(r, img.bytes.miniatura, `${sufixo || '(sem v)'}:`);
        assert.equal(r.headers['cache-control'], 'private, no-cache', sufixo);
        assert.equal(r.headers.etag, referencia.headers.etag, sufixo);
        assert.deepEqual(tokensDeVary(r), ['cookie', 'origin'], sufixo);
      }
    });

    test('CAD-03 — 304 válido na cadeia: sem corpo, com ETag, Cache-Control, Vary, CORP e CORS iguais aos do 200; o ETag de outra variante não vale; HEAD tem os mesmos cabeçalhos do GET', async () => {
      const caminho = alvo('empresa', img.id, 'miniatura', `?v=${img.versao}`);
      const r200 = await pedir(cadeia, master, caminho);
      ok(r200, img.bytes.miniatura, 'âncora:');
      const r304 = await pedir(cadeia, master, caminho, { condicional: r200.headers.etag });
      assert.equal(r304.status, 304, aviso(r304));
      assert.equal(Buffer.isBuffer(r304.body) ? r304.body.length : Object.keys(r304.body ?? {}).length, 0, '304 não leva corpo');
      for (const nome of ['etag', 'cache-control', 'cross-origin-resource-policy', 'access-control-allow-origin', 'access-control-allow-credentials']) {
        assert.equal(r304.headers[nome], r200.headers[nome], nome);
      }
      assert.deepEqual(tokensDeVary(r304), ['cookie', 'origin']);
      assert.equal(r304.headers['set-cookie'], undefined);
      helmetIntacto(r304, '304:');
      const doutraVariante = await pedir(cadeia, master, caminho, { condicional: `"${img.hashes.exibicao}"` });
      ok(doutraVariante, img.bytes.miniatura, 'ETag de outra variante:');
      const head = await pedir(cadeia, master, caminho, { metodo: 'head' });
      assert.equal(head.status, 200, aviso(head));
      assert.deepEqual(cabecalhosComparaveis(head), cabecalhosComparaveis(r200), 'HEAD tem os cabeçalhos do GET');
      const head304 = await pedir(cadeia, master, caminho, { metodo: 'head', condicional: r200.headers.etag });
      assert.equal(head304.status, 304);
      assert.equal(head304.headers['cache-control'], r200.headers['cache-control']);
    });

    test('CAD-04 — CORS: origem permitida recebe a origem EXATA com credentials; origem estranha, do Painel Privado ou ausente não recebe nenhum Access-Control-*; nunca "*"; Vary inclui Origin e Cookie em todos os casos', async () => {
      const caminho = alvo('empresa', img.id, 'miniatura', `?v=${img.versao}`);
      ok(await pedir(cadeia, master, caminho), img.bytes.miniatura, 'âncora:');
      for (const [nome, origem] of [['permitida', a.ORIGEM_PERMITIDA], ['estranha', 'https://mal.test'], ['do Painel Privado', 'http://localhost:5501'], ['ausente', null]]) {
        const r = await pedir(cadeia, master, caminho, { origem });
        ok(r, img.bytes.miniatura, `${nome}:`);
        semCoringa(r, nome);
        if (origem === a.ORIGEM_PERMITIDA) {
          assert.equal(r.headers['access-control-allow-origin'], a.ORIGEM_PERMITIDA, nome);
          assert.equal(r.headers['access-control-allow-credentials'], 'true', nome);
        } else {
          assert.deepEqual(cabecalhosCors(r), [], `${nome}: nenhum Access-Control-* para origem não permitida ou ausente`);
        }
        assert.deepEqual(tokensDeVary(r), ['cookie', 'origin'], nome);
      }
    });
  });

  describe('[CAD] recusas na cadeia real', () => {
    test('CAD-05 — toda recusa é JSON sem cache: 401, 403, 400, 404 (inexistente, de outra empresa, variante desconhecida) e 503 têm `Cache-Control: no-store`, nenhum ETag nem tipo de imagem, CORP same-origin e o corpo padrão de erro; o `private` da imagem nunca vaza para um erro', async () => {
      ok(await pedir(cadeia, master, alvo('empresa', img.id, 'miniatura', `?v=${img.versao}`)), img.bytes.miniatura, 'âncora:');
      const casos = [
        ['401 sem sessão', cadeia, null, alvo('empresa', img.id, 'miniatura'), 401],
        ['403 sem permissão', cadeia, semNada, alvo('empresa', img.id, 'miniatura'), 403],
        ['400 id inválido', cadeia, master, alvo('empresa', '05', 'miniatura'), 400],
        ['400 `v` inválido', cadeia, master, alvo('empresa', img.id, 'miniatura', '?v=abc'), 400],
        ['404 inexistente', cadeia, master, alvo('empresa', '999999999999', 'miniatura'), 404],
        ['404 de outra empresa', cadeia, masterB, alvo('empresa', img.id, 'miniatura'), 404],
        ['404 variante desconhecida', cadeia, master, alvo('empresa', img.id, 'mestre'), 404],
        ['503 sem armazenamento', cadeiaSemArmazenamento, master, alvo('empresa', img.id, 'miniatura'), 503],
      ];
      for (const [nome, app, usuario, caminho, status] of casos) {
        const r = await pedir(app, usuario, caminho);
        assert.equal(r.status, status, `${nome}: ${aviso(r)}`);
        assert.equal(r.headers['cache-control'], 'no-store', `${nome}: recusa sem cache`);
        // O Express gera um ETag FRACO para o JSON do erro; o que não pode aparecer é o ETag FORTE da imagem (o SHA-256 da variante).
        assert.doesNotMatch(String(r.headers.etag ?? ''), /[0-9a-f]{64}/, `${nome}: sem o ETag da imagem`);
        assert.doesNotMatch(String(r.headers['content-type']), /^image\//, `${nome}: sem tipo de imagem`);
        assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin', nome);
        assert.equal(r.body.status, 'error', nome);
        assert.equal(typeof r.body.codigo, 'string', nome);
        assert.equal(r.headers['set-cookie'], undefined, nome);
        semCoringa(r, nome);
        helmetIntacto(r, `${nome}:`);
      }
    });

    test('CAD-06 — as recusas 404 da entrega são IDÊNTICAS na cadeia real (corpo e todos os cabeçalhos): imagem de outra empresa, inexistente, inativa, variante desconhecida e padrão inativa', async () => {
      const inativa = await semearEmpresa(a, { empresaId: a.d.empresaA, atorId: a.d.master, nome: 'Inativa da cadeia', inativar: true });
      const padraoInativo = await semearPadrao(a, { nome: 'Padrão inativo da cadeia', ativo: false });
      ok(await pedir(cadeia, master, alvo('empresa', img.id, 'miniatura')), img.bytes.miniatura, 'âncora:');
      const referencia = await pedir(cadeia, master, alvo('empresa', '999999999999', 'miniatura'));
      assert.equal(referencia.status, 404, aviso(referencia));
      assert.equal(referencia.body.codigo, 'IMAGEM_NAO_ENCONTRADA', aviso(referencia));
      for (const [nome, usuario, caminho] of [
        ['de outra empresa', masterB, alvo('empresa', img.id, 'miniatura')],
        ['inativa', master, alvo('empresa', inativa.id, 'miniatura')],
        ['variante desconhecida', master, alvo('empresa', img.id, 'original')],
        ['padrão inativa', master, alvo('padrao', padraoInativo.id, 'miniatura')],
      ]) {
        const r = await pedir(cadeia, usuario, caminho);
        assert.equal(r.status, 404, `${nome}: ${aviso(r)}`);
        assert.deepEqual(r.body, referencia.body, nome);
        assert.deepEqual(cabecalhosComparaveis(r), cabecalhosComparaveis(referencia), `${nome}: cabeçalhos`);
      }
    });
  });

  describe('[CAD] Cross-Origin-Resource-Policy da imagem entregue', () => {
    test('CAD-07 — padrão: a imagem sai com same-origin em 200, 304 e HEAD (a política do Helmet não é flexibilizada sem pedido explícito)', async () => {
      const caminho = alvo('empresa', img.id, 'miniatura', `?v=${img.versao}`);
      const r200 = await pedir(cadeia, master, caminho);
      ok(r200, img.bytes.miniatura, '200:');
      assert.equal(r200.headers['cross-origin-resource-policy'], 'same-origin');
      const r304 = await pedir(cadeia, master, caminho, { condicional: r200.headers.etag });
      assert.equal(r304.status, 304, aviso(r304));
      assert.equal(r304.headers['cross-origin-resource-policy'], 'same-origin');
      const head = await pedir(cadeia, master, caminho, { metodo: 'head' });
      assert.equal(head.status, 200, aviso(head));
      assert.equal(head.headers['cross-origin-resource-policy'], 'same-origin');
    });

    test('CAD-08 — desenvolvimento local (`corp: same-site`): a imagem sai com same-site em 200, 304 e HEAD; já os erros da entrega, a listagem da biblioteca, os materiais e uma rota inexistente continuam same-origin — o Helmet global não é afrouxado', async () => {
      const caminho = alvo('empresa', img.id, 'miniatura', `?v=${img.versao}`);
      const r200 = await pedir(cadeiaSameSite, master, caminho);
      ok(r200, img.bytes.miniatura, '200:');
      assert.equal(r200.headers['cross-origin-resource-policy'], 'same-site');
      const r304 = await pedir(cadeiaSameSite, master, caminho, { condicional: r200.headers.etag });
      assert.equal(r304.status, 304, aviso(r304));
      assert.equal(r304.headers['cross-origin-resource-policy'], 'same-site');
      const head = await pedir(cadeiaSameSite, master, caminho, { metodo: 'head' });
      assert.equal(head.status, 200, aviso(head));
      assert.equal(head.headers['cross-origin-resource-policy'], 'same-site');
      for (const [nome, usuario, rota, esperado] of [
        ['404 da entrega', master, alvo('empresa', '999999999999', 'miniatura'), 404],
        ['401 da entrega', null, alvo('empresa', img.id, 'miniatura'), 401],
        ['403 da entrega', semNada, alvo('empresa', img.id, 'miniatura'), 403],
        ['listagem da biblioteca', master, BASE, 200],
        ['materiais', master, '/api/materiais', 200],
        ['rota inexistente', master, '/api/nao-existe', 404],
      ]) {
        const r = await pedir(cadeiaSameSite, usuario, rota);
        assert.equal(r.status, esperado, `${nome}: ${aviso(r)}`);
        assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin', `${nome}: só a imagem entregue usa a política flexibilizada`);
      }
    });

    test('CAD-09 — produção sem flexibilização (NODE_ENV=production, IMAGENS_ENTREGA_CORP ausente ou same-origin): a imagem sai com same-origin em 200 e 304', async () => {
      for (const corp of [undefined, 'same-origin']) {
        await comAmbiente({ NODE_ENV: 'production', IMAGENS_ENTREGA_CORP: corp }, async () => {
          const app = a.cadeiaDeProducao();
          const caminho = alvo('empresa', img.id, 'miniatura', `?v=${img.versao}`);
          const r200 = await pedir(app, master, caminho);
          ok(r200, img.bytes.miniatura, `produção, IMAGENS_ENTREGA_CORP=${corp}:`);
          assert.equal(r200.headers['cross-origin-resource-policy'], 'same-origin');
          const r304 = await pedir(app, master, caminho, { condicional: r200.headers.etag });
          assert.equal(r304.status, 304, aviso(r304));
          assert.equal(r304.headers['cross-origin-resource-policy'], 'same-origin');
        });
      }
    });

    test('CAD-10 — produção NUNCA aceita `same-site`: com NODE_ENV=production e IMAGENS_ENTREGA_CORP=same-site a montagem da entrega é recusada (IMAGENS_CONFIGURACAO_INVALIDA, nomeando a variável)', async () => {
      await comAmbiente({ NODE_ENV: 'production', IMAGENS_ENTREGA_CORP: 'same-site' }, async () => {
        assert.throws(
          () => a.cadeiaDeProducao(),
          (falha) => falha.codigo === 'IMAGENS_CONFIGURACAO_INVALIDA' && /IMAGENS_ENTREGA_CORP/.test(falha.message),
          'a política flexível em produção deveria impedir a montagem (ainda não implementado)',
        );
      });
    });

    test('CAD-11 — fora de produção a configuração `IMAGENS_ENTREGA_CORP=same-site` (frontend e API em portas distintas do mesmo site) vale só para a imagem; os erros da entrega continuam same-origin', async () => {
      for (const ambiente of ['development', 'test', undefined]) {
        await comAmbiente({ NODE_ENV: ambiente, IMAGENS_ENTREGA_CORP: 'same-site' }, async () => {
          const app = a.cadeiaDeProducao();
          const r200 = await pedir(app, master, alvo('empresa', img.id, 'miniatura', `?v=${img.versao}`));
          ok(r200, img.bytes.miniatura, `NODE_ENV=${ambiente}:`);
          assert.equal(r200.headers['cross-origin-resource-policy'], 'same-site', `NODE_ENV=${ambiente}`);
          const r404 = await pedir(app, master, alvo('empresa', '999999999999', 'miniatura'));
          assert.equal(r404.status, 404, `NODE_ENV=${ambiente}: ${aviso(r404)}`);
          assert.equal(r404.headers['cross-origin-resource-policy'], 'same-origin', `NODE_ENV=${ambiente}: o erro não usa a política flexível`);
        });
      }
    });

    test('CAD-12 — valor desconhecido é recusado ao montar em qualquer ambiente (cross-origin, *, maiúsculas): nunca vira política de CORP', async () => {
      for (const ruim of ['cross-origin', '*', 'SAME-SITE']) {
        await comAmbiente({ NODE_ENV: 'development', IMAGENS_ENTREGA_CORP: ruim }, async () => {
          assert.throws(
            () => a.cadeiaDeProducao(),
            (falha) => falha.codigo === 'IMAGENS_CONFIGURACAO_INVALIDA' && /IMAGENS_ENTREGA_CORP/.test(falha.message),
            `IMAGENS_ENTREGA_CORP=${ruim} deveria impedir a montagem (ainda não implementado)`,
          );
        });
      }
    });
  });
});
