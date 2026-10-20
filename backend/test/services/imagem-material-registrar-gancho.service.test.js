'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const imagemEmpresaRepo = require('../../src/repositories/imagem-empresa.repository');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const servico = require('../../src/services/imagem-material.service');

/**
 * Biblioteca de Imagens, Unidade 5C-2 — o gancho `antesDeInserir` de `registrarEmpresa` (a única mudança no serviço existente). Sem PostgreSQL: a conexão e
 * os repositórios são simulados e gravam eventos numa linha do tempo comum. O que se garante:
 *   - o gancho roda DENTRO da transação, sob a trava da biblioteca que o próprio serviço já tomou (UMA aquisição só; o gancho não toma trava, então não
 *     há aquisição recursiva nem deadlock), depois da deduplicação e da cota e antes do INSERT;
 *   - conteúdo já existente e cota esgotada nunca chamam o gancho (nada de arquivo gravado por uma recusa);
 *   - se o gancho lança, a transação é desfeita: nenhuma linha, nenhuma auditoria, e o erro sobe como está;
 *   - sem o gancho nada muda.
 */

const hex = (c) => c.repeat(64);
const DESCRITOR = Object.freeze({
  sha256: hex('a'), sha256Mestre: hex('b'), sha256Exibicao: hex('c'), sha256Miniatura: hex('d'), formato: 'PNG', largura: 320, altura: 320, bytesMestre: 1000, bytesExibicao: 500, bytesMiniatura: 100,
});
const PEDIDO = Object.freeze({ empresaId: 3, atorId: 9, nome: 'Luva', imagem: DESCRITOR });

function montar(t, { existente = null, consumo = { imagens: 0, bytes: 0, bytesArmazenados: 0 } } = {}) {
  const eventos = [];
  const cliente = {
    query: async (sql) => { eventos.push(`sql:${String(sql).trim().split(/\s+/)[0].toUpperCase()}`); return { rows: [] }; },
    release: () => { eventos.push('release'); },
  };
  const pool = { connect: async () => { eventos.push('connect'); return cliente; } };
  t.mock.method(imagemEmpresaRepo, 'travarBiblioteca', async () => { eventos.push('travar'); });
  t.mock.method(imagemEmpresaRepo, 'buscarPorSha256', async () => { eventos.push('buscar'); return existente; });
  t.mock.method(imagemEmpresaRepo, 'somarConsumo', async () => { eventos.push('somar'); return consumo; });
  t.mock.method(imagemEmpresaRepo, 'inserir', async (_executor, dados) => {
    eventos.push('inserir');
    return { id: '9', versao: 1, estado: 'ATIVA', ...dados };
  });
  t.mock.method(auditoriaRepo, 'registrar', async () => { eventos.push('auditar'); });
  return { eventos, pool };
}

describe('registrarEmpresa — gancho antesDeInserir (Unidade 5C-2)', () => {
  test('GAN-01 — sem gancho nada muda: uma trava, deduplicação, cota, INSERT, auditoria e COMMIT', async (t) => {
    const { eventos, pool } = montar(t);
    const r = await servico.registrarEmpresa(pool, PEDIDO);
    assert.equal(r.reaproveitada, false);
    assert.deepEqual(eventos, ['connect', 'sql:BEGIN', 'travar', 'buscar', 'somar', 'inserir', 'auditar', 'sql:COMMIT', 'release']);
  });

  test('GAN-02 — com gancho: roda na transação, sob a única trava já tomada, depois da deduplicação e da cota e ANTES do INSERT', async (t) => {
    const { eventos, pool } = montar(t);
    const r = await servico.registrarEmpresa(pool, { ...PEDIDO, antesDeInserir: async () => { eventos.push('gancho'); } });
    assert.equal(r.reaproveitada, false);
    assert.deepEqual(eventos, ['connect', 'sql:BEGIN', 'travar', 'buscar', 'somar', 'gancho', 'inserir', 'auditar', 'sql:COMMIT', 'release']);
    assert.equal(eventos.filter((e) => e === 'travar').length, 1, 'a trava da biblioteca é tomada uma vez só');
  });

  test('GAN-03 — o gancho é aguardado: o INSERT só acontece depois de ele terminar, mesmo que demore', async (t) => {
    const { eventos, pool } = montar(t);
    const r = await servico.registrarEmpresa(pool, {
      ...PEDIDO,
      antesDeInserir: async () => {
        eventos.push('gancho:inicio');
        await new Promise((resolve) => { setImmediate(resolve); });
        await new Promise((resolve) => { setImmediate(resolve); });
        eventos.push('gancho:fim');
      },
    });
    assert.equal(r.reaproveitada, false);
    assert.deepEqual(eventos.slice(eventos.indexOf('somar') + 1, eventos.indexOf('inserir') + 1), ['gancho:inicio', 'gancho:fim', 'inserir']);
  });

  test('GAN-04 — conteúdo já existente na empresa: o gancho NÃO roda (nenhum arquivo é gravado por um reenvio), sem INSERT e sem auditoria', async (t) => {
    const existente = {
      id: '41', empresaId: 3, nome: 'Antiga', formato: 'PNG', largura: 320, altura: 320, versao: 1, estado: 'INATIVA',
    };
    const { eventos, pool } = montar(t, { existente });
    let chamadas = 0;
    const r = await servico.registrarEmpresa(pool, { ...PEDIDO, antesDeInserir: async () => { chamadas += 1; } });
    assert.deepEqual([r.reaproveitada, r.imagem.id, r.imagem.estado], [true, '41', 'INATIVA']);
    assert.equal(chamadas, 0);
    assert.deepEqual(eventos, ['connect', 'sql:BEGIN', 'travar', 'buscar', 'sql:COMMIT', 'release']);
  });

  test('GAN-05 — cota esgotada: o gancho NÃO roda, 409 IMAGEM_COTA_EXCEDIDA, a transação é desfeita e nada é inserido nem auditado', async (t) => {
    const { eventos, pool } = montar(t, { consumo: { imagens: 300, bytes: 0, bytesArmazenados: 0 } });
    let chamadas = 0;
    await assert.rejects(
      servico.registrarEmpresa(pool, { ...PEDIDO, antesDeInserir: async () => { chamadas += 1; } }),
      (falha) => falha.status === 409 && falha.codigo === 'IMAGEM_COTA_EXCEDIDA',
    );
    assert.equal(chamadas, 0);
    assert.deepEqual(eventos, ['connect', 'sql:BEGIN', 'travar', 'buscar', 'somar', 'sql:ROLLBACK', 'release']);
  });

  test('GAN-06 — gancho que lança: o MESMO erro sobe, a transação é desfeita, a conexão é devolvida e nada é inserido nem auditado', async (t) => {
    const { eventos, pool } = montar(t);
    const defeito = Object.assign(new Error('falha ao gravar'), { codigo: 'ARMAZENAMENTO_FALHOU' });
    await assert.rejects(servico.registrarEmpresa(pool, { ...PEDIDO, antesDeInserir: async () => { throw defeito; } }), (falha) => falha === defeito);
    assert.deepEqual(eventos, ['connect', 'sql:BEGIN', 'travar', 'buscar', 'somar', 'sql:ROLLBACK', 'release']);
  });

  test('GAN-07 — gancho que não é função: TypeError antes de abrir qualquer conexão', async (t) => {
    const { eventos, pool } = montar(t);
    for (const invalido of ['gravar', 1, {}, true]) {
      await assert.rejects(servico.registrarEmpresa(pool, { ...PEDIDO, antesDeInserir: invalido }), TypeError, String(invalido));
    }
    assert.deepEqual(eventos, []);
  });
});
