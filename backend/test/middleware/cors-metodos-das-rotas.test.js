'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const request = require('supertest');

const app = require('../../src/app');
const { METODOS_PORTAL, METODOS_PLATAFORMA } = require('../../src/middleware/cors');

/**
 * Os métodos que o CORS de cada namespace anuncia são EXATAMENTE os que as
 * rotas montadas dele usam (mais o HEAD, que o Express atende pelo GET). Assim
 * uma rota nova com PUT ou DELETE não passa despercebida (o navegador
 * cross-origin bloquearia o preflight), e o Painel Privado nunca anuncia um
 * verbo que nenhuma rota dele usa (menor privilégio). Lido da pilha real do
 * app, sem repetir a lista de rotas.
 */

const IMPLICITO = ['HEAD'];

// Camadas de roteador do app: as que atendem /api/plataforma (cadeia própria) e as que atendem /api.
function roteadoresDo(namespace) {
  return app.router.stack.filter((camada) => {
    if (!camada.handle || !Array.isArray(camada.handle.stack)) return false;
    const daPlataforma = camada.match('/api/plataforma/x');
    const doPortal = camada.match('/api/x');
    return namespace === 'plataforma' ? daPlataforma && !doPortal : doPortal;
  });
}

function rotasDe(pilha, acumulado = []) {
  for (const camada of pilha) {
    if (camada.route) {
      for (const [metodo, ativo] of Object.entries(camada.route.methods)) {
        if (ativo) acumulado.push({ metodo: metodo.toUpperCase(), caminho: camada.route.path });
      }
    } else if (camada.handle && Array.isArray(camada.handle.stack)) {
      rotasDe(camada.handle.stack, acumulado);
    }
  }
  return acumulado;
}

const rotasDoNamespace = (namespace) => roteadoresDo(namespace).flatMap((camada) => rotasDe(camada.handle.stack));
const metodosUsados = (namespace) => [...new Set(rotasDoNamespace(namespace).map((r) => r.metodo))].sort();

describe('CORS: métodos anunciados por namespace x métodos das rotas montadas', () => {
  test('o app tem rotas nos dois namespaces (a leitura da pilha funciona)', () => {
    assert.ok(rotasDoNamespace('portal').length > 50, `portal: ${rotasDoNamespace('portal').length}`);
    assert.ok(rotasDoNamespace('plataforma').length > 15, `plataforma: ${rotasDoNamespace('plataforma').length}`);
  });

  test('Portal: todo método usado por uma rota de /api está anunciado, e nada além deles (e do HEAD) é anunciado', () => {
    const usados = metodosUsados('portal');
    assert.deepEqual([...METODOS_PORTAL].sort(), [...new Set([...usados, ...IMPLICITO])].sort());
    for (const metodo of ['PUT', 'DELETE']) assert.ok(usados.includes(metodo), `o Portal usa ${metodo}`);
  });

  // Todas estas já precisavam de PUT ou DELETE no CORS (só funcionavam no mesmo site); a remoção do vínculo SST (12F-2) é a mais recente.
  test('as rotas PUT e DELETE do Portal são conhecidas: autorizações individuais, vínculo de material ao GHE, vínculo de usuário a grupo, mínimos e vínculo SST', () => {
    const verbosInseguros = rotasDoNamespace('portal').filter((r) => r.metodo === 'PUT' || r.metodo === 'DELETE').map((r) => `${r.metodo} ${r.caminho}`).sort();
    assert.deepEqual(verbosInseguros, [
      'DELETE /autorizacoes-individuais/:id',
      'DELETE /grupos-homogeneos/:id/materiais/:materialId',
      'DELETE /materiais/:id/minimos/:tamanho',
      'DELETE /usuarios/:usuarioId/grupo-acesso',
      'DELETE /vinculos-sst/:usuarioId',
      'PUT /grupos-acesso/:id/usuarios/:usuarioId',
      'PUT /materiais/:id/minimos/:tamanho',
    ]);
  });

  test('Painel Privado: só GET, POST e PATCH são usados, e é só isso (mais HEAD) que ele anuncia; PUT e DELETE não aparecem', () => {
    const usados = metodosUsados('plataforma');
    assert.deepEqual(usados, ['GET', 'PATCH', 'POST']);
    assert.deepEqual([...METODOS_PLATAFORMA].sort(), [...new Set([...usados, ...IMPLICITO])].sort());
    assert.ok(!METODOS_PLATAFORMA.includes('PUT') && !METODOS_PLATAFORMA.includes('DELETE'));
  });

  test('o único PATCH do Painel Privado é a alteração de empresa (documentado: é ele que exige PATCH no CORS da plataforma)', () => {
    const patches = rotasDoNamespace('plataforma').filter((r) => r.metodo === 'PATCH');
    assert.deepEqual(patches.map((r) => r.caminho), ['/empresas/:id']);
  });

  test('CORS e verificação de origem são camadas separadas: PUT e DELETE continuam sendo métodos inseguros para a origem, no Portal real', async () => {
    const PERMITIDA = 'http://localhost:5500';
    for (const metodo of ['put', 'delete']) {
      const rota = '/api/materiais/1/minimos/M';
      const semOrigem = await request(app)[metodo](rota).send(metodo === 'put' ? { minimo: 1 } : undefined);
      assert.deepEqual([semOrigem.status, semOrigem.body.codigo], [403, 'ORIGEM_AUSENTE'], metodo);
      const estranha = await request(app)[metodo](rota).set('Origin', 'http://mal.test').send(metodo === 'put' ? { minimo: 1 } : undefined);
      assert.deepEqual([estranha.status, estranha.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], metodo);
      const daPlataforma = await request(app)[metodo](rota).set('Origin', 'http://localhost:5501').send(metodo === 'put' ? { minimo: 1 } : undefined);
      assert.deepEqual([daPlataforma.status, daPlataforma.body.codigo], [403, 'ORIGEM_NAO_PERMITIDA'], `${metodo}: a origem do Painel não vale no Portal`);
      const permitida = await request(app)[metodo](rota).set('Origin', PERMITIDA).send(metodo === 'put' ? { minimo: 1 } : undefined);
      assert.equal(permitida.status, 401, `${metodo}: com a origem permitida a requisição chega à autenticação`);
    }
  });
});
