'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { classificarDurabilidade, criarDestinoDuravel, ARMAZENAMENTOS_DURAVEIS_APROVADOS } = require('../../src/services/imagem-backup-durabilidade.service');

/** Durabilidade: classificação das cinco dimensões e contrato do destino externo com adaptadores inteiramente FALSOS (sem rede, sem serviço real). */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const SHA = 'a'.repeat(64);
const PEDIDO = { chave: 'prep-1/dump/postgres.dump', sha256: SHA, bytes: 1234 };
const captura = (extra = {}) => ({ ok: true, bytesRecebidos: 10, bytesGravados: 10, fsyncConcluido: true, ...extra });
const publicada = { publicada: true, estado: 'PUBLICADA' };
const destino = (confirmar, prazoMs = 200) => criarDestinoDuravel({ id: 'teste-duravel', adaptador: { confirmar }, prazoMs });
const eco = async (p) => ({ confirmado: true, ...p });

describe('[DU-A] classificação separada', () => {
  teste('DU-A01 — gravado, sincronizado localmente e publicado NÃO são durável nem restaurável', () => {
    const c = classificarDurabilidade({ captura: captura(), publicacao: publicada });
    assert.deepEqual({ ...c }, { arquivoGravado: true, sincronizadoLocalmente: true, pacotePublicado: true, estadoIncerto: false, duravelmenteArmazenado: false, restauravelComprovado: false, observacao: 'FSYNC_LOCAL_NAO_E_DURABILIDADE_REMOTA' });
  });

  teste('DU-A02 — falhas de gravação e de sincronização, publicação revertida ou INCERTA: cada dimensão cai sozinha', () => {
    assert.equal(classificarDurabilidade({ captura: captura({ bytesGravados: 9 }), publicacao: publicada }).arquivoGravado, false);
    assert.equal(classificarDurabilidade({ captura: captura({ ok: false }), publicacao: publicada }).arquivoGravado, false);
    const semFsync = classificarDurabilidade({ captura: captura({ fsyncConcluido: false }), publicacao: publicada });
    assert.deepEqual([semFsync.arquivoGravado, semFsync.sincronizadoLocalmente, semFsync.pacotePublicado], [true, false, true]);
    const revertida = classificarDurabilidade({ captura: captura(), publicacao: { publicada: false, estado: 'REVERTIDA' } });
    assert.deepEqual([revertida.pacotePublicado, revertida.sincronizadoLocalmente, revertida.estadoIncerto], [false, false, false]);
    const incerta = classificarDurabilidade({ captura: captura(), publicacao: { publicada: false, estado: 'INCERTA' } });
    assert.deepEqual([incerta.pacotePublicado, incerta.estadoIncerto, incerta.duravelmenteArmazenado], [false, true, false]);
    assert.equal(classificarDurabilidade().arquivoGravado, false);
  });

  teste('DU-A03 — confirmação LITERAL, clonada ou de teste não torna nada durável nem restaurável', async () => {
    const real = await destino(eco).confirmarGravacao(PEDIDO);
    assert.deepEqual([real.confirmado, real.operacional, real.origem], [true, false, 'TESTE_CONTROLADO']);
    for (const confirmacao of [real, { ...real }, { confirmado: true, operacional: true, origem: 'OPERACIONAL' }, 'ok', null]) {
      const c = classificarDurabilidade({ captura: captura(), publicacao: publicada, confirmacao, restauravelComprovado: true });
      assert.deepEqual([c.duravelmenteArmazenado, c.restauravelComprovado], [false, false]);
    }
  });
});

describe('[DU-B] contrato do destino durável externo', () => {
  teste('DU-B01 — nenhum armazenamento durável aprovado; fora de NODE_ENV=test a criação é recusada; configuração estrita', () => {
    assert.deepEqual([...ARMAZENAMENTOS_DURAVEIS_APROVADOS], []);
    const antes = process.env.NODE_ENV;
    try {
      process.env.NODE_ENV = 'production';
      assert.throws(() => destino(eco), (e) => e.code === 'ARMAZENAMENTO_DURAVEL_NAO_APROVADO');
    } finally { process.env.NODE_ENV = antes; }
    for (const ruim of [null, {}, { id: 'X!', adaptador: { confirmar() {} }, prazoMs: 10 }, { id: 'a', adaptador: {}, prazoMs: 10 }, { id: 'a', adaptador: { confirmar() {} }, prazoMs: 0 }, { id: 'a', adaptador: { confirmar() {} }, prazoMs: 10, extra: 1 }]) assert.throws(() => criarDestinoDuravel(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });

  teste('DU-B02 — só a resposta EXATA do adaptador confirma; divergência de chave/hash/bytes, campos extras, confirmação parcial, exceção e atraso são INCONCLUSIVOS (nunca durável)', async () => {
    const casos = [
      async (p) => ({ ...p, confirmado: false }),
      async (p) => ({ confirmado: true, ...p, sha256: 'b'.repeat(64) }),
      async (p) => ({ confirmado: true, ...p, bytes: p.bytes - 1 }),
      async (p) => ({ confirmado: true, ...p, chave: 'outra/chave' }),
      async (p) => ({ confirmado: true, ...p, extra: 1 }),
      async () => ({ confirmado: true }),
      async () => { throw new Error('armazenamento fora do ar'); },
      () => new Promise(() => {}),
      async () => 'ok',
      async () => null,
    ];
    for (const [i, confirmar] of casos.entries()) {
      const c = await destino(confirmar, 50).confirmarGravacao(PEDIDO);
      assert.deepEqual([c.confirmado, c.operacional, c.motivo], [false, false, 'CONFIRMACAO_INCONCLUSIVA_OU_DIVERGENTE'], `caso ${i}`);
    }
    const ok = await destino(eco).confirmarGravacao(PEDIDO);
    assert.deepEqual([ok.confirmado, ok.motivo], [true, null]);
  });

  teste('DU-B03 — pedido malformado é recusado antes de chamar o adaptador', async () => {
    let chamadas = 0;
    const d = destino(async (p) => { chamadas += 1; return eco(p); });
    for (const ruim of [null, {}, { ...PEDIDO, sha256: 'xyz' }, { ...PEDIDO, bytes: -1 }, { ...PEDIDO, chave: '../x' }, { ...PEDIDO, extra: 1 }]) await assert.rejects(() => d.confirmarGravacao(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA');
    assert.equal(chamadas, 0);
  });
});
