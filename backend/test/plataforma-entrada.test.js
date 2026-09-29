'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const request = require('supertest');

/**
 * Entrada das rotas de autenticação do Painel Privado, pelo app real:
 * método, tipo de conteúdo e tamanho são recusados antes de qualquer
 * consulta. Nenhum destes testes usa o PostgreSQL.
 */

const ORIGEM = 'http://localhost:5501';
const RAIZ = path.join(__dirname, '..');
const ROTAS_POST = [
  '/auth/login', '/auth/logout', '/auth/mfa/liberacao', '/auth/mfa/cadastro/reiniciar', '/auth/mfa/cadastro/confirmar',
  '/auth/mfa/verificar', '/auth/mfa/recuperacao', '/auth/mfa/substituicao/iniciar', '/auth/mfa/substituicao/confirmar',
  '/auth/mfa/recuperacao/regenerar',
];
const NAO_ENCONTRADA = { status: 'error', codigo: 'ROTA_NAO_ENCONTRADA', message: 'Rota não encontrada' };

describe('rotas de autenticação do Painel Privado: método, conteúdo e tamanho', () => {
  const app = require('../src/app');
  const em = (caminho) => `/api/plataforma${caminho}`;

  test('rota de POST chamada com GET, PUT, PATCH ou DELETE: 404, sem cookie e sem executar nada', async () => {
    for (const caminho of ROTAS_POST) {
      for (const metodo of ['get', 'put', 'patch', 'delete']) {
        const r = await request(app)[metodo](em(caminho)).set('Origin', ORIGEM);
        assert.deepEqual([r.status, r.body], [404, NAO_ENCONTRADA], `${metodo.toUpperCase()} ${caminho}`);
        assert.equal(r.headers['set-cookie'], undefined, `${metodo.toUpperCase()} ${caminho}`);
        assert.equal(r.headers['cache-control'], 'no-store');
      }
    }
  });

  test('rota de GET chamada com POST: 404', async () => {
    for (const caminho of ['/auth/me', '/auth/mfa/estado', '/painel']) {
      const r = await request(app).post(em(caminho)).set('Origin', ORIGEM);
      assert.deepEqual([r.status, r.body], [404, NAO_ENCONTRADA], caminho);
    }
  });

  test('corpo que não é application/json: 415 antes da rota, em todas as rotas de POST', async () => {
    for (const caminho of ROTAS_POST) {
      for (const tipo of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data; boundary=x']) {
        const r = await request(app).post(em(caminho)).set('Origin', ORIGEM).set('Content-Type', tipo).send('codigo=123456');
        assert.deepEqual([r.status, r.body.codigo], [415, 'TIPO_CONTEUDO_NAO_SUPORTADO'], `${caminho} com ${tipo}`);
        assert.equal(r.headers['set-cookie'], undefined);
      }
    }
  });

  test('JSON em outra codificação: 415', async () => {
    const r = await request(app).post(em('/auth/login')).set('Origin', ORIGEM)
      .set('Content-Type', 'application/json; charset=utf-16').send(Buffer.from('{"email":"a@b.co","senha":"x"}', 'utf16le'));
    assert.deepEqual([r.status, r.body.codigo], [415, 'CODIFICACAO_NAO_SUPORTADA']);
  });

  test('corpo acima do limite: 413 antes da rota; JSON malformado: 400', async () => {
    const gigante = JSON.stringify({ email: 'admin@safework.com.br', senha: 'x'.repeat(40000) });
    const grande = await request(app).post(em('/auth/login')).set('Origin', ORIGEM).set('Content-Type', 'application/json').send(gigante);
    assert.deepEqual([grande.status, grande.body.codigo], [413, 'PAYLOAD_MUITO_GRANDE']);

    const quebrado = await request(app).post(em('/auth/login')).set('Origin', ORIGEM).set('Content-Type', 'application/json').send('{"email":');
    assert.deepEqual([quebrado.status, quebrado.body.codigo], [400, 'JSON_INVALIDO']);
  });

  test('login: senha e e-mail acima do tamanho, tipos errados e campo a mais dão 400 de validação, sem ecoar o valor', async () => {
    const casos = [
      { email: 'admin@safework.com.br', senha: 'x'.repeat(1025) },
      { email: `${'a'.repeat(300)}@safework.com.br`, senha: 'senha-qualquer-12345' },
      { email: ['admin@safework.com.br'], senha: 'senha-qualquer-12345' },
      { email: 'admin@safework.com.br', senha: { $ne: null } },
      { email: 'admin@safework.com.br', senha: 'senha-qualquer-12345', administradorId: 1 },
      { email: 'admın@safework.com.br', senha: 'senha-qualquer-12345' },
    ];
    for (const corpo of casos) {
      const r = await request(app).post(em('/auth/login')).set('Origin', ORIGEM).set('Content-Type', 'application/json').send(corpo);
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo).slice(0, 60));
      assert.equal(JSON.stringify(r.body).includes('senha-qualquer-12345'), false);
      assert.equal(r.headers['set-cookie'], undefined);
    }
  });

  test('sem Origin ou com origem de fora: 403 antes da rota, inclusive no logout', async () => {
    for (const caminho of ROTAS_POST) {
      const semOrigem = await request(app).post(em(caminho));
      assert.deepEqual([semOrigem.status, semOrigem.body.codigo], [403, 'ORIGEM_AUSENTE'], caminho);
      const deFora = await request(app).post(em(caminho)).set('Origin', 'http://localhost:5500');
      assert.deepEqual([deFora.status, deFora.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], caminho);
      assert.equal(deFora.headers['set-cookie'], undefined, caminho);
    }
  });
});

describe('quem escreve em desafios_mfa_plataforma', () => {
  const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
  const semComentarios = (codigo) => codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

  function arquivosJs(dir) {
    return fs.readdirSync(path.join(RAIZ, dir), { withFileTypes: true }).flatMap((e) => {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) return arquivosJs(rel);
      return e.name.endsWith('.js') ? [rel] : [];
    });
  }

  test('só o repositório de desafios escreve na tabela; ninguém apaga linha', () => {
    const escritores = [];
    for (const arquivo of [...arquivosJs('src'), ...arquivosJs('scripts')]) {
      const codigo = semComentarios(ler(arquivo));
      if (/(INSERT INTO|UPDATE|DELETE FROM)\s+desafios_mfa_plataforma/i.test(codigo)) escritores.push(arquivo);
      assert.equal(/DELETE FROM\s+desafios_mfa_plataforma/i.test(codigo), false, arquivo);
    }
    assert.deepEqual(escritores, [path.join('src', 'repositories', 'desafio-mfa-plataforma.repository.js')]);
  });

  test('todo UPDATE exige desafio aberto; a única escrita depois de encerrado é o vínculo, uma vez, em desafio CONCLUIDO', () => {
    const codigo = semComentarios(ler('src/repositories/desafio-mfa-plataforma.repository.js'));
    const updates = [...codigo.matchAll(/UPDATE desafios_mfa_plataforma\s+SET ([\s\S]*?)\s+WHERE ([\s\S]*?)`/g)].map((m) => ({ set: m[1], where: m[2] }));
    assert.equal(updates.length, 7);

    const emAberto = updates.filter((u) => /encerrado_em IS NULL/.test(u.where));
    const depois = updates.filter((u) => !/encerrado_em IS NULL/.test(u.where));
    assert.equal(emAberto.length, 6);
    assert.equal(depois.length, 1);
    assert.match(depois[0].set, /^sessao_criada_id = \$2$/);
    assert.match(depois[0].where, /sessao_criada_id IS NULL AND motivo_encerramento = 'CONCLUIDO'/);

    for (const u of updates) {
      for (const campo of ['administrador_id', 'tipo', 'criado_em', 'token_hash', 'expira_em', 'sessao_origem_id', 'desafio_anterior_id']) {
        assert.equal(new RegExp(`(^|,)\\s*${campo}\\s*=`).test(u.set), false, `nenhum fluxo altera ${campo}`);
      }
    }
  });
});
