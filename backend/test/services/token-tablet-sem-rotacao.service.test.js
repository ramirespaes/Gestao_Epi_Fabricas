'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');

const service = require('../../src/services/token-tablet.service');
const credencialRepo = require('../../src/repositories/token-credencial.repository');
const redeRepo = require('../../src/repositories/token-rede.repository');
const controleRepo = require('../../src/repositories/token-evento-controle.repository');
const eventoRepo = require('../../src/repositories/token-dispositivo-evento.repository');
const { gerarTokenSessao, hashTokenSessao } = require('../../src/security/token');

/**
 * Atendimento Token — autenticar(pool, { credencial, ip, rotacionar }) sem banco: os repositórios são substituídos e o que importa é o que a
 * autenticação decide e se a rotação é (ou não) chamada. `rotacionar` ausente preserva a rotação atual; `false` nunca rotaciona.
 */

const LINHA = { id: 7, empresa_id: 3, nome: 'Tablet A', unidade: null, setor: null, local_instalacao: null, revogado_em: null, empresa_ativa: true, expirada: false, atual: true, na_carencia: false, rotacao_devida: true };
const consultas = [];
const pool = { connect: async () => ({ query: async (sql) => { consultas.push(sql); return { rows: [] }; }, release() {} }) };

function preparar(t, { linha = LINHA, rede = true, rotacionou = true } = {}) {
  const chamadas = { rotacionar: [], eventos: [], suprimidos: [], rede: [] };
  consultas.length = 0;
  t.mock.method(credencialRepo, 'buscarPorCredencial', async () => (linha === null ? null : { ...linha }));
  t.mock.method(redeRepo, 'ipFixoAutorizado', async (_p, empresaId, ip) => { chamadas.rede.push([empresaId, ip]); return rede; });
  t.mock.method(credencialRepo, 'rotacionar', async (_c, dados) => { chamadas.rotacionar.push(dados); return rotacionou; });
  t.mock.method(eventoRepo, 'registrar', async (_c, dados) => { chamadas.eventos.push(dados); });
  t.mock.method(controleRepo, 'registrarSuprimido', async (_p, dados) => { chamadas.suprimidos.push(dados); });
  return chamadas;
}
const rejeitaCom = (promessa, codigo) => assert.rejects(promessa, (e) => e.codigo === codigo);
const entrada = (extra = {}) => ({ credencial: gerarTokenSessao(), ip: '10.0.0.5', ...extra });

describe('[TSR] autenticar — opção rotacionar', () => {
  test('TSR-01 — padrão (opção ausente): a rotação devida continua acontecendo e a nova credencial é devolvida', async (t) => {
    const c = preparar(t);
    const r = await service.autenticar(pool, entrada());
    assert.equal(c.rotacionar.length, 1);
    assert.match(r.novaCredencial, /^[A-Za-z0-9_-]{20,}$/);
    assert.deepEqual(c.eventos.map((e) => e.tipo), ['CREDENCIAL_RENOVADA']);
    assert.equal(c.rotacionar[0].novaCredencialHash, hashTokenSessao(r.novaCredencial));
  });

  test('TSR-02 — `rotacionar: true` explícito equivale ao padrão', async (t) => {
    const c = preparar(t);
    const r = await service.autenticar(pool, entrada({ rotacionar: true }));
    assert.equal(c.rotacionar.length, 1);
    assert.notEqual(r.novaCredencial, null);
  });

  test('TSR-03 — `rotacionar: false` com rotação devida: autentica, NÃO rotaciona, NÃO abre transação nem registra evento, novaCredencial é null', async (t) => {
    const c = preparar(t);
    const r = await service.autenticar(pool, entrada({ rotacionar: false }));
    assert.equal(r.novaCredencial, null);
    assert.deepEqual(r.dispositivo, { id: 7, empresaId: 3, nome: 'Tablet A', unidade: null, setor: null, localInstalacao: null });
    assert.deepEqual(c.rotacionar, []);
    assert.deepEqual(c.eventos, []);
    assert.deepEqual(consultas, [], 'nenhuma transação foi aberta');
    assert.deepEqual(c.rede, [[3, '10.0.0.5']], 'a rede continua sendo conferida');
  });

  test('TSR-04 — sem rotação devida o resultado é o mesmo com e sem a opção (novaCredencial null, sem rotacionar)', async (t) => {
    for (const rotacionar of [undefined, true, false]) {
      const c = preparar(t, { linha: { ...LINHA, rotacao_devida: false } });
      const r = await service.autenticar(pool, entrada({ rotacionar }));
      assert.equal(r.novaCredencial, null);
      assert.deepEqual(c.rotacionar, []);
      t.mock.restoreAll();
    }
  });

  test('TSR-05 — credencial anterior DENTRO da carência segue aceita, nunca rotaciona, com ou sem a opção', async (t) => {
    for (const rotacionar of [undefined, false]) {
      const c = preparar(t, { linha: { ...LINHA, atual: false, na_carencia: true } });
      const r = await service.autenticar(pool, entrada({ rotacionar }));
      assert.equal(r.novaCredencial, null);
      assert.deepEqual(c.rotacionar, []);
      assert.deepEqual(c.suprimidos, []);
      t.mock.restoreAll();
    }
  });

  test('TSR-06 — credencial anterior FORA da carência segue recusada com REUSO_CREDENCIAL (supressão existente), com ou sem a opção', async (t) => {
    for (const rotacionar of [undefined, false]) {
      const c = preparar(t, { linha: { ...LINHA, atual: false, na_carencia: false } });
      await rejeitaCom(service.autenticar(pool, entrada({ rotacionar })), 'DISPOSITIVO_NAO_AUTORIZADO');
      assert.deepEqual(c.suprimidos.map((s) => [s.tipo, s.empresaId, s.dispositivoId, s.janelaSegundos]), [['REUSO_CREDENCIAL', 3, 7, service.JANELA_SUPRESSAO_EVENTOS_SEGUNDOS]]);
      assert.deepEqual(c.rede, [], 'a rede nem chega a ser consultada');
      assert.deepEqual(c.rotacionar, []);
      t.mock.restoreAll();
    }
  });

  test('TSR-07 — rede não autorizada segue recusada com 403 REDE_NAO_AUTORIZADA e o registro REDE_RECUSADA, e nunca rotaciona, com ou sem a opção', async (t) => {
    for (const rotacionar of [undefined, false]) {
      const c = preparar(t, { rede: false });
      await rejeitaCom(service.autenticar(pool, entrada({ rotacionar })), 'REDE_NAO_AUTORIZADA');
      assert.deepEqual(c.suprimidos.map((s) => s.tipo), ['REDE_RECUSADA']);
      assert.deepEqual(c.rotacionar, []);
      t.mock.restoreAll();
    }
  });

  test('TSR-08 — tablet inexistente, revogado, empresa inativa, credencial expirada ou formato inválido seguem recusados (401), com ou sem a opção', async (t) => {
    const casos = [null, { ...LINHA, revogado_em: new Date() }, { ...LINHA, empresa_ativa: false }, { ...LINHA, expirada: true }];
    for (const linha of casos) {
      for (const rotacionar of [undefined, false]) {
        const c = preparar(t, { linha });
        await rejeitaCom(service.autenticar(pool, entrada({ rotacionar })), 'DISPOSITIVO_NAO_AUTORIZADO');
        assert.deepEqual(c.rotacionar, []);
        t.mock.restoreAll();
      }
    }
    for (const credencial of [null, undefined, '', 'curta', 123]) {
      const c = preparar(t);
      await rejeitaCom(service.autenticar(pool, { credencial, ip: '10.0.0.5', rotacionar: false }), 'DISPOSITIVO_NAO_AUTORIZADO');
      assert.deepEqual(c.rede, []);
      t.mock.restoreAll();
    }
  });

  test('TSR-09 — só o valor `false` desliga a rotação: qualquer outro valor mantém o comportamento atual (falha segura para o lado da rotação existente)', async (t) => {
    for (const valor of [undefined, true, 0, null, '', 'false']) {
      const c = preparar(t);
      const r = await service.autenticar(pool, entrada({ rotacionar: valor }));
      assert.equal(c.rotacionar.length, 1, String(valor));
      assert.notEqual(r.novaCredencial, null, String(valor));
      t.mock.restoreAll();
    }
  });

  test('TSR-10 — a rotação concorrente perdida (ganhou=false) segue reavaliando a credencial, como antes, quando a opção é omitida', async (t) => {
    const c = preparar(t, { rotacionou: false });
    const r = await service.autenticar(pool, entrada());
    assert.equal(c.rotacionar.length, 1);
    assert.equal(r.novaCredencial, null);
    assert.deepEqual(c.eventos, []);
  });
});
