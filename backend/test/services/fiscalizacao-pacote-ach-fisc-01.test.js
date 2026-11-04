'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { decidirDescarteAposFalha, DESCARTE } = require('../../src/services/fiscalizacao-pacote.service');

/**
 * ACH-FISC-01 (D-ORF-6, P3): depois do COMMIT que marca CONCLUIDO, uma exceção no `catch` externo da geração NÃO pode remover o ZIP publicado. A decisão é
 * pura e fail-closed: só GERANDO/FALHA liberam a remoção dos resíduos; CONCLUIDO devolve o pacote; situação desconhecida preserva tudo. O fluxo real
 * (falha injetada após o COMMIT, com PostgreSQL) está em test/integracao/relatorios-fiscalizacao.integration.js.
 */

describe('ACH-FISC-01 — decisão de descarte após falha na geração', () => {
  test('AF-01 — CONCLUIDO preserva e devolve o pacote; GERANDO e FALHA liberam a remoção dos resíduos; qualquer outra situação preserva', () => {
    assert.equal(decidirDescarteAposFalha({ status: 'CONCLUIDO' }), DESCARTE.CONCLUIDO);
    assert.equal(decidirDescarteAposFalha({ status: 'GERANDO' }), DESCARTE.REMOVER_RESIDUOS);
    assert.equal(decidirDescarteAposFalha({ status: 'FALHA' }), DESCARTE.REMOVER_RESIDUOS);
    for (const incerto of [null, undefined, 'CONCLUIDO', 42, {}, { status: null }, { status: 'concluido' }, { status: 'OUTRO' }]) assert.equal(decidirDescarteAposFalha(incerto), DESCARTE.PRESERVAR, JSON.stringify(incerto));
    assert.ok(Object.isFrozen(DESCARTE));
  });

  test('AF-02 — GUARD ESTÁTICO: no catch externo da geração a situação é relida ANTES da remoção, a remoção depende da decisão e CONCLUIDO retorna sem remover', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src/services/fiscalizacao-pacote.service.js'), 'utf8');
    const catchExterno = fonte.slice(fonte.indexOf("return pacoteDto(await pacoteRepo.buscarPorId(pool, empresaId, id));"), fonte.indexOf("if (perdido) throw new HttpError(409, 'GERACAO_ABANDONADA'"));
    assert.match(catchExterno, /situacao = await pacoteRepo\.buscarPorId\(pool, empresaId, id\)/);
    assert.match(catchExterno, /const descarte = decidirDescarteAposFalha\(situacao\);/);
    assert.match(catchExterno, /if \(descarte === DESCARTE\.CONCLUIDO\) return pacoteDto\(situacao\);/);
    assert.match(catchExterno, /if \(descarte === DESCARTE\.REMOVER_RESIDUOS\) await armazenamento\.removerResiduos\(\{ empresaId, pacoteId: id \}\)/);
    assert.ok(catchExterno.indexOf('decidirDescarteAposFalha(situacao)') < catchExterno.indexOf('removerResiduos('), 'a decisão precede a remoção');
    assert.equal((catchExterno.match(/removerResiduos\(/g) ?? []).length, 1, 'uma única chamada de remoção no catch externo');
    // a recuperação de abandonados continua restrita a GERANDO (FOR UPDATE SKIP LOCKED na consulta do repositório)
    const repo = fs.readFileSync(path.join(__dirname, '..', '..', 'src/repositories/fiscalizacao-pacote.repository.js'), 'utf8');
    assert.match(repo, /WHERE status = 'GERANDO' AND heartbeat_em <[\s\S]*FOR UPDATE SKIP LOCKED/);
  });
});
