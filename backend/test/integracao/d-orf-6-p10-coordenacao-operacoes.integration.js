'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Client } = require('pg');
const { abrirSchemaTemporario } = require('./helpers/schema-temporario');
const { configuracaoDoBancoDeTeste, confirmarBancoDeTeste } = require('./helpers/banco-de-teste');
const { aplicarMigrations } = require('../../scripts/migrate');
const K = require('../../src/services/backup-fontes-coordenacao-operacoes.service');
const Kc = require('../helpers/p4b-caracterizacao');

/**
 * D-ORF-6, P10 — coordenação de operações incompatíveis com PostgreSQL 16 EFÊMERO (só na CI do GitHub Actions, marcador `GEPI_CI_EFEMERO`; fora dela, pulado).
 * Prova: (1) o id do cadeado de migração usado pelo módulo é o MESMO exportado pelo `node-pg-migrate`; (2) com o BACKUP segurando a exclusão numa sessão, uma
 * migração real (`aplicarMigrations`, `advisoryLockMode: 'fail'`) FALHA RÁPIDO em vez de esperar e nada é aplicado; (3) duas sessões: a segunda operação
 * incompatível é recusada sem bloquear; (4) liberada a exclusão, a migração passa. Só advisory locks de sessão: nada persistente.
 */

describe('D-ORF-6 P10 — exclusão mútua backup × migração × limpeza (só na CI efêmera)', () => {
  test('backup segurando a exclusão faz a migração falhar rápido; operação incompatível é recusada sem espera; liberada, a migração passa', async (t) => {
    const motivo = Kc.motivoDeRecusaCi(process.env);
    if (motivo !== null) { t.skip(`P10_SO_EM_CI_EFEMERA: ${motivo}`); return; }
    const { PG_MIGRATE_LOCK_ID } = await import('node-pg-migrate');
    assert.equal(String(PG_MIGRATE_LOCK_ID), String(K.PG_MIGRATE_LOCK_ID), 'id do cadeado de migração do módulo = id do node-pg-migrate');

    const configuracao = configuracaoDoBancoDeTeste();
    const sessaoBackup = new Client(configuracao);
    const sessaoOutra = new Client(configuracao);
    let contexto = null;
    const diretorio = fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-p10-mig-'));
    fs.writeFileSync(path.join(diretorio, '001_alfa.sql'), 'CREATE TABLE alfa_p10 (id INTEGER PRIMARY KEY);\n');
    let exclusao = null;
    try {
      await sessaoBackup.connect();
      await sessaoOutra.connect();
      await confirmarBancoDeTeste(sessaoBackup);
      const { rows: marcador } = await sessaoBackup.query(Kc.SQL_MARCADOR_DO_BANCO);
      assert.ok(Kc.marcadorDoBancoConfere(marcador[0]?.marcador, Kc.marcadorEsperadoCi(process.env)), 'instância efêmera de CI não comprovada');
      contexto = await abrirSchemaTemporario([]);

      // (2) backup segura a exclusão: a migração real falha rápido e nada é aplicado
      exclusao = await K.adquirirExclusao(sessaoBackup, { operacao: 'BACKUP' });
      assert.equal(exclusao.ok, true, JSON.stringify(exclusao));
      await assert.rejects(() => aplicarMigrations({ schema: contexto.schema, diretorio }), 'a migração precisa falhar com o cadeado tomado pelo backup');
      const { rows: existe } = await contexto.cliente.query('SELECT to_regclass($1) IS NOT NULL AS existe', [`${contexto.schema}.alfa_p10`]);
      assert.equal(existe[0].existe, false, 'nada aplicado');

      // (3) outra sessão: limpeza (incompatível) recusada sem bloquear; restauração também recusada (cadeado de migração comum, declarado)
      const limpeza = await K.adquirirExclusao(sessaoOutra, { operacao: 'LIMPEZA' });
      assert.deepEqual([limpeza.ok, limpeza.motivo], [false, 'MIGRACAO_EM_CURSO']);
      const rest = await K.adquirirExclusao(sessaoOutra, { operacao: 'RESTAURACAO' });
      assert.equal(rest.ok, false);

      // (4) liberada a exclusão, a migração passa e a limpeza consegue a dela
      assert.deepEqual(await exclusao.liberar(), { liberados: 3 });
      exclusao = null;
      const aplicadas = await aplicarMigrations({ schema: contexto.schema, diretorio });
      assert.equal(aplicadas.length, 1);
      const depois = await K.adquirirExclusao(sessaoOutra, { operacao: 'LIMPEZA' });
      assert.equal(depois.ok, true);
      await depois.liberar();
      process.stdout.write(`P10_OBSERVACAO_JSON ${JSON.stringify({ ci: { run: process.env.GITHUB_RUN_ID }, cadeadoMigracao: String(PG_MIGRATE_LOCK_ID), migracaoFalhouComBackup: true, limpezaRecusada: 'MIGRACAO_EM_CURSO', migracaoPassouDepois: aplicadas.length })}\n`);
    } finally {
      if (exclusao !== null) await exclusao.liberar().catch(() => {});
      await sessaoOutra.end().catch(() => {});
      await sessaoBackup.end().catch(() => {});
      if (contexto !== null) await contexto.encerrar().catch(() => {});
      fs.rmSync(diretorio, { recursive: true, force: true });
    }
  });
});
