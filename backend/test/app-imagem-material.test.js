'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');
const http = require('node:http');
const { once } = require('node:events');

/**
 * As rotas HTTP da biblioteca de imagens (Unidade 4) estão montadas no app REAL, sob /api e atrás da cadeia global (CORS, origem, JSON, limite):
 * sem sessão, cada uma responde 401 (nunca 404, nunca 200); as escritas passam antes pela verificação de origem (CSRF) e a recusam sem Origin da
 * allowlist; o Painel Privado não atende nenhum desses caminhos; e NÃO existe rota de escrita da biblioteca padrão, de registro por descritor
 * (404). O ENVIO binário (POST /imagens-material/empresa) é contrato da Unidade 5C-1 (RED) e tem os seus testes no fim deste arquivo. Desde a Unidade 5A-1 existe também a ENTREGA de arquivos (GET /imagens-material/:origem/:id/:variante), igualmente protegida
 * por sessão. Nada aqui acessa o banco: a origem e exigirSessao recusam antes. Prova a MONTAGEM em app.js, que os testes de rota com app de teste
 * não provam.
 */

describe('app.js — rotas da biblioteca de imagens (Unidade 4)', () => {
  const app = require('../src/app');
  const ORIGEM = 'http://localhost:5500';
  const ORIGEM_DO_PAINEL = 'http://localhost:5501';
  const ID = '9007199254740993';
  const LEITURAS = ['/api/imagens-material', '/api/imagens-material?origem=PADRAO&busca=luva'];
  const ESCRITAS = [
    ['patch', `/api/imagens-material/empresa/${ID}`, { nome: 'x' }],
    ['post', `/api/imagens-material/empresa/${ID}/inativar`, {}],
    ['post', `/api/imagens-material/empresa/${ID}/reativar`, {}],
    ['delete', `/api/imagens-material/empresa/${ID}`, { confirmacao: true }],
  ];
  const enviar = (metodo, rota, corpo, origem) => {
    const r = request(app)[metodo](rota);
    if (origem !== undefined) r.set('Origin', origem);
    return r.send(corpo);
  };

  test('nenhuma consulta é pública: sem cookie de sessão, 401 SESSAO_INVALIDA em GET e HEAD', async () => {
    for (const rota of LEITURAS) {
      const r = await request(app).get(rota).set('Origin', ORIGEM);
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], `GET ${rota}`);
      assert.equal((await request(app).head(rota).set('Origin', ORIGEM)).status, 401, `HEAD ${rota}`);
    }
  });

  test('nenhuma escrita é pública: com a origem do Portal e sem sessão, 401 SESSAO_INVALIDA (a sessão é decidida antes da validação do id e do corpo)', async () => {
    for (const [metodo, rota, corpo] of ESCRITAS) {
      const r = await enviar(metodo, rota, corpo, ORIGEM);
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], `${metodo.toUpperCase()} ${rota}`);
    }
    const invalida = await enviar('delete', '/api/imagens-material/empresa/05', {}, ORIGEM);
    assert.deepEqual([invalida.status, invalida.body.codigo], [401, 'SESSAO_INVALIDA'], 'id e corpo inválidos sem sessão: 401, nunca 400');
  });

  test('CSRF: a escrita sem Origin é 403 ORIGEM_AUSENTE; com origem estranha ou a do Painel Privado, 403 ORIGEM_NAO_PERMITIDA', async () => {
    for (const [metodo, rota, corpo] of ESCRITAS) {
      const sem = await enviar(metodo, rota, corpo);
      assert.deepEqual([sem.status, sem.body.codigo], [403, 'ORIGEM_AUSENTE'], `${metodo.toUpperCase()} ${rota}`);
      for (const origem of ['http://mal.test', ORIGEM_DO_PAINEL]) {
        const r = await enviar(metodo, rota, corpo, origem);
        assert.deepEqual([r.status, r.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], `${metodo.toUpperCase()} ${rota} ${origem}`);
      }
    }
  });

  test('o Painel Privado não atende a biblioteca: com a origem dele, 404 fixo na cadeia própria (leitura e escritas)', async () => {
    const leitura = await request(app).get('/api/plataforma/imagens-material').set('Origin', ORIGEM_DO_PAINEL);
    assert.deepEqual([leitura.status, leitura.body.codigo], [404, 'ROTA_NAO_ENCONTRADA']);
    for (const [metodo, rota, corpo] of ESCRITAS) {
      const r = await enviar(metodo, rota.replace('/api/', '/api/plataforma/'), corpo, ORIGEM_DO_PAINEL);
      assert.deepEqual([r.status, r.body.codigo], [404, 'ROTA_NAO_ENCONTRADA'], `${metodo.toUpperCase()} ${rota}`);
    }
  });

  // Unidade 5A-1 (RED): a entrega de arquivos passa a existir. Substitui as expectativas de inexistência da Unidade 4 (os "cinco caminhos" e os dois GETs
  // de entrega em "o que NÃO existe") pelos contratos novos: seis caminhos, 401 sem sessão na entrega, e nenhum outro método no caminho da entrega.
  const ENTREGAS = [
    ['empresa', 'miniatura'], ['empresa', 'exibicao'], ['padrao', 'miniatura'], ['padrao', 'exibicao'],
  ].map(([origem, variante]) => `/api/imagens-material/${origem}/${ID}/${variante}`);

  test('os caminhos montados da biblioteca são EXATAMENTE os sete aprovados: os cinco de gestão, a entrega e o ENVIO binário da 5C-1 (nenhuma rota de registro por descritor nem de escrita na padrão)', () => {
    const caminhos = [];
    const percorrer = (pilha) => {
      for (const camada of pilha) {
        if (camada.route) {
          for (const [metodo, ativo] of Object.entries(camada.route.methods)) if (ativo) caminhos.push(`${metodo.toUpperCase()} ${camada.route.path}`);
        } else if (camada.handle && Array.isArray(camada.handle.stack)) percorrer(camada.handle.stack);
      }
    };
    percorrer(app.router.stack);
    const montados = caminhos.filter((c) => /imagens-material/.test(c)).sort();
    const esperados = [
      'DELETE /imagens-material/empresa/:id',
      'GET /imagens-material',
      'GET /imagens-material/:origem/:id/:variante',
      'PATCH /imagens-material/empresa/:id',
      'POST /imagens-material/empresa',
      'POST /imagens-material/empresa/:id/inativar',
      'POST /imagens-material/empresa/:id/reativar',
    ];
    const faltando = esperados.filter((c) => !montados.includes(c));
    assert.deepEqual(faltando, [], `rota(s) ainda não montada(s) em app.js (não implementado): ${faltando.join(', ')}`);
    assert.deepEqual(montados, esperados);
  });

  test('a ENTREGA de arquivos é protegida na cadeia real: sem cookie de sessão, 401 SESSAO_INVALIDA em GET e HEAD (empresa e padrão, miniatura e exibição); nunca 404 nem 200', async () => {
    for (const rota of ENTREGAS) {
      const get = await request(app).get(rota).set('Origin', ORIGEM);
      assert.deepEqual([get.status, get.body.codigo], [401, 'SESSAO_INVALIDA'], `GET ${rota}: ${get.status} ${JSON.stringify(get.body)}`);
      assert.equal(get.headers['cache-control'], 'no-store', `GET ${rota}: erro sem cache`);
      const head = await request(app).head(rota).set('Origin', ORIGEM);
      assert.equal(head.status, 401, `HEAD ${rota}`);
    }
  });

  test('a sessão é decidida ANTES de validar: sem cookie, id inválido, `v` inválido e query extra na entrega também são 401 (nunca 400)', async () => {
    for (const rota of ['/api/imagens-material/empresa/05/miniatura', `/api/imagens-material/empresa/${ID}/miniatura?v=abc`, `/api/imagens-material/empresa/${ID}/miniatura?empresaId=2`, '/api/imagens-material/x/y/z']) {
      const r = await request(app).get(rota).set('Origin', ORIGEM);
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], `${rota}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  test('o Helmet global NÃO é afrouxado: a política CORP continua same-origin nas rotas da API (saúde, gestão e entrega, sem sessão) — qualquer flexibilização de desenvolvimento vale só para a imagem entregue com sucesso', async () => {
    for (const rota of ['/api/health', '/api/imagens-material', ENTREGAS[0]]) {
      const r = await request(app).get(rota).set('Origin', ORIGEM);
      assert.equal(r.headers['cross-origin-resource-policy'], 'same-origin', `${rota}: ${r.status}`);
      assert.equal(r.headers['x-content-type-options'], 'nosniff', rota);
    }
  });

  test('o caminho da entrega só aceita GET e HEAD: POST, PUT, PATCH e DELETE respondem 404 ROTA_NAO_ENCONTRADA (com a origem do Portal)', async () => {
    for (const metodo of ['post', 'put', 'patch', 'delete']) {
      const r = await enviar(metodo, ENTREGAS[0], {}, ORIGEM);
      assert.deepEqual([r.status, r.body.codigo], [404, 'ROTA_NAO_ENCONTRADA'], `${metodo.toUpperCase()}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  });

  test('o que NÃO existe: escrita sob a biblioteca padrão, registro por descritor e qualquer outro método no caminho do envio respondem 404 ROTA_NAO_ENCONTRADA (com a origem do Portal)', async () => {
    const inexistentes = [
      ['patch', `/api/imagens-material/padrao/${ID}`, { nome: 'x' }], ['post', `/api/imagens-material/padrao/${ID}/inativar`, {}], ['delete', `/api/imagens-material/padrao/${ID}`, { confirmacao: true }],
      ['post', '/api/imagens-material', { nome: 'x' }], ['put', `/api/imagens-material/empresa/${ID}`, {}],
      ['get', `/api/imagens-material/empresa/${ID}`, undefined], ['get', '/api/imagens-material/empresa', undefined], ['put', '/api/imagens-material/empresa', {}],
      ['patch', '/api/imagens-material/empresa', {}], ['delete', '/api/imagens-material/empresa', {}],
    ];
    for (const [metodo, rota, corpo] of inexistentes) {
      const r = corpo === undefined ? await request(app)[metodo](rota).set('Origin', ORIGEM) : await enviar(metodo, rota, corpo, ORIGEM);
      // Com sessão ausente, a rota inexistente cai no 404 do app; nunca 200 nem 201.
      assert.equal(r.body.codigo, 'ROTA_NAO_ENCONTRADA', `${metodo.toUpperCase()} ${rota}: ${r.status} ${JSON.stringify(r.body)}`);
    }
  });
});

/**
 * Unidade 5C-1 (RED) — o ENVIO binário da imagem da empresa (POST /api/imagens-material/empresa?nome=) na cadeia REAL de app.js (CORS, origem, limite geral,
 * política de conteúdo). Nada aqui acessa o banco: a origem e a sessão recusam antes. O contrato completo da rota (permissão, limites, corpo, nome) está em
 * test/routes/imagem-material-envio.routes.test.js; aqui só se prova o que depende da MONTAGEM: sem cookie de sessão o envio é 401 (a política de conteúdo
 * deixa passar o corpo de imagem no caminho exato, e só nele), a sessão é decidida antes de validar consulta e corpo, e a verificação de origem (CSRF) vem
 * antes de qualquer outra coisa. APP-ENV-03 é verde hoje e precisa continuar verde.
 */
describe('app.js — envio binário de imagem da empresa (Unidade 5C-1)', () => {
  const app = require('../src/app');
  const ORIGEM = 'http://localhost:5500';
  const ORIGEM_DO_PAINEL = 'http://localhost:5501';
  const CAMINHO = '/api/imagens-material/empresa';
  const resumo = (r) => `${r.status} ${JSON.stringify(r.body)}`;
  // `origem: null` = pedido SEM cabeçalho Origin (undefined cairia no valor padrão e enviaria a origem do Portal).
  const enviarImagem = (consulta, { origem = ORIGEM, tipo = 'image/png', corpo = Buffer.alloc(512, 9) } = {}) => {
    const r = request(app).post(`${CAMINHO}${consulta}`);
    if (origem !== null) r.set('Origin', origem);
    return r.set('Content-Type', tipo).send(corpo);
  };
  const exigirMontado = (r) => {
    if (r.status === 415 && r.body?.codigo === 'TIPO_CONTEUDO_NAO_SUPORTADO') {
      assert.fail(`contrato futuro: o envio binário (POST ${CAMINHO}) ainda não está montado em app.js — o corpo de imagem foi recusado pela política de conteúdo: ${resumo(r)}`);
    }
    return r;
  };

  test('APP-ENV-01 — sem cookie de sessão, o envio de imagem (PNG, JPEG e WebP) é 401 SESSAO_INVALIDA: nunca 415, nunca 404, nunca 201', async () => {
    for (const tipo of ['image/png', 'image/jpeg', 'image/webp']) {
      const r = exigirMontado(await enviarImagem('?nome=Luva', { tipo }));
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], `${tipo}: ${resumo(r)}`);
    }
  });

  test('APP-ENV-02 — a sessão é decidida ANTES de validar a consulta e o corpo: sem cookie, nome ausente, chave estranha e formato não suportado também são 401 (nunca 400 ou 415 por conteúdo); o corpo grande é o APP-ENV-02b', async () => {
    // Cada pedido só é CRIADO na sua vez: o supertest abre o servidor efêmero ao criar o pedido, e um pedido criado e nunca enviado deixaria o processo pendurado.
    const casos = [
      ['nome ausente', () => enviarImagem('')],
      ['chave estranha na consulta', () => enviarImagem('?nome=x&empresaId=2')],
      ['imagem de formato não suportado', () => enviarImagem('?nome=x', { tipo: 'image/gif', corpo: Buffer.from('GIF89a') })],
    ];
    for (const [rotulo, criarPedido] of casos) {
      const r = exigirMontado(await criarPedido());
      assert.deepEqual([r.status, r.body.codigo], [401, 'SESSAO_INVALIDA'], `${rotulo}: ${resumo(r)}`);
    }
  });

  test('APP-ENV-02b — a sessão é decidida ANTES de ler o corpo: sem cookie, o 401 chega mesmo com 2 MiB anunciados e só 1 KiB enviado (o corpo grande não é lido antes de autenticar)', async () => {
    // Cliente de corpo parcial: um servidor que respondesse só depois de ler o corpo não responderia (2,5 s). Corpo grande COMPLETO não serve aqui: com a resposta antecipada o
    // Node derruba a conexão e o cliente vê EPIPE/ECONNRESET em vez do 401.
    const servidor = app.listen(0, '127.0.0.1');
    await once(servidor, 'listening');
    const { port } = servidor.address();
    try {
      const r = await new Promise((resolver, rejeitar) => {
        let concluido = false;
        let limite = null;
        const terminar = (acao, valor) => {
          if (concluido) return;
          concluido = true;
          clearTimeout(limite);
          acao(valor);
        };
        const req = http.request({
          host: '127.0.0.1', port, method: 'POST', path: `${CAMINHO}?nome=Luva`, headers: { Origin: ORIGEM, 'Content-Type': 'image/png', 'Content-Length': String(2 * 1024 * 1024) },
        });
        limite = setTimeout(() => {
          req.destroy();
          terminar(rejeitar, new Error('sem resposta antes do fim do corpo: o corpo foi lido antes de autenticar?'));
        }, 2500);
        req.on('error', (falha) => terminar(rejeitar, falha));
        req.on('response', (res) => {
          const partes = [];
          res.on('data', (p) => partes.push(p));
          res.on('end', () => {
            let corpo = null;
            try { corpo = JSON.parse(Buffer.concat(partes).toString('utf8')); } catch { corpo = null; }
            req.destroy();
            terminar(resolver, { status: res.statusCode, body: corpo });
          });
        });
        req.write(Buffer.alloc(1024, 1));
      });
      exigirMontado(r);
      assert.deepEqual([r.status, r.body?.codigo], [401, 'SESSAO_INVALIDA'], resumo(r));
    } finally {
      servidor.closeAllConnections();
      await new Promise((resolver) => { servidor.close(resolver); });
    }
  });

  test('APP-ENV-03 (verde hoje; proteção de regressão) — CSRF: o envio sem Origin é 403 ORIGEM_AUSENTE; com origem estranha ou a do Painel Privado, 403 ORIGEM_NAO_PERMITIDA — antes da política de conteúdo e da sessão', async () => {
    const sem = await enviarImagem('?nome=Luva', { origem: null });
    assert.deepEqual([sem.status, sem.body.codigo], [403, 'ORIGEM_AUSENTE'], resumo(sem));
    for (const origem of ['http://mal.test', ORIGEM_DO_PAINEL]) {
      const r = await enviarImagem('?nome=Luva', { origem });
      assert.deepEqual([r.status, r.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], `${origem}: ${resumo(r)}`);
    }
  });
});
