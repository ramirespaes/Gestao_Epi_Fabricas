'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarGerenciadorDeFixtures } = require('../helpers/fixtures-descartaveis');

/**
 * O gerenciador de fixtures dos testes remove e altera permissões SÓ por identidade: link simbólico, troca de inode, homônimo e diretório fora de tmp nunca são tocados — nem ganham `chmod`. Tudo em diretórios temporários do próprio teste.
 */

const teste = (nome, a, b) => (typeof a === 'function' ? test(nome, { timeout: 30000 }, a) : test(nome, { timeout: 30000, ...a }, b));
const TMP = fs.realpathSync(os.tmpdir());
const ehRoot = typeof process.getuid === 'function' && process.getuid() === 0;
const modo = (p) => fs.lstatSync(p).mode & 0o777;
const existe = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };
const fim = criarGerenciadorDeFixtures({ prefixo: 'gepi-fixt-fim-' });
after(() => { fim.remover(); });
/** Cria uma "vítima" (diretório de terceiro, não registrado) que o teste limpa ao fim pelo gerenciador de fechamento. */
const vitima = (m = 0o755) => { const v = fim.criar(); fim.chmod(v, m); return v; };

describe('[FX-A] criação e remoção por identidade', () => {
  teste('FX-A01 — criar registra o diretório (0700, em tmp, descritor guardado) e remover o apaga; remover é idempotente', () => {
    const g = criarGerenciadorDeFixtures({ prefixo: 'gepi-fixt-a01-' });
    const d = g.criar();
    assert.equal(path.dirname(d), TMP);
    assert.equal(modo(d), 0o700);
    fs.writeFileSync(path.join(d, 'x'), 'x');
    assert.deepEqual(g.remover(), { removidas: [d], ignoradas: [] });
    assert.equal(existe(d), false);
    assert.deepEqual(g.remover(), { removidas: [], ignoradas: [] });
  });

  teste('FX-A02 — diretório deixado SEM permissão pelo teste (0000) é removido sem `chmod` por caminho: a permissão é restabelecida pelo descritor', { skip: ehRoot }, () => {
    const g = criarGerenciadorDeFixtures({ prefixo: 'gepi-fixt-a02-' });
    const d = g.criar();
    fs.writeFileSync(path.join(d, 'x'), 'x');
    g.chmod(d, 0o000);
    assert.equal(modo(d), 0o000);
    assert.deepEqual(g.remover().removidas, [d]);
    assert.equal(existe(d), false);
  });

  teste('FX-A03 — renomeado pelo próprio teste: o registro acompanha o MESMO objeto; um caminho que não é o registrado é recusado', () => {
    const g = criarGerenciadorDeFixtures({ prefixo: 'gepi-fixt-a03-' });
    const d = g.criar();
    const novo = `${d}-lateral`;
    fs.renameSync(d, novo);
    assert.equal(g.renomeado(d, novo), novo);
    const impostor = fs.mkdtempSync(path.join(TMP, 'gepi-fixt-a03-imp-'));
    const h = criarGerenciadorDeFixtures({ prefixo: 'gepi-fixt-a03b-' });
    const outro = h.criar();
    assert.throws(() => g.renomeado(novo, outro), /não é o diretório registrado/);
    fs.rmdirSync(impostor);
    h.remover();
    assert.deepEqual(g.remover().removidas, [novo]);
  });

  teste('FX-A04 — registro recusa o que não é diretório próprio em tmp: fora de tmp, link, arquivo, relativo e caminho não normalizado', () => {
    const g = criarGerenciadorDeFixtures({ prefixo: 'gepi-fixt-a04-' });
    const real = vitima();
    const ln = path.join(TMP, `gepi-fixt-a04-ln-${process.pid}`);
    fs.symlinkSync(real, ln);
    const arquivo = path.join(real, 'a');
    fs.writeFileSync(arquivo, 'a');
    try {
      for (const ruim of [os.homedir(), path.join(real, 'sub'), ln, arquivo, 'relativo', `${real}/../x`, '/', 7, null]) assert.throws(() => g.adotar(ruim), Error, String(ruim));
      assert.equal(existe(real), true);
    } finally { fs.unlinkSync(ln); }
    assert.throws(() => criarGerenciadorDeFixtures({ prefixo: '../x' }), TypeError);
  });
});

describe('[FX-B] substituição por link ou por outro objeto: falha fechada, sem alterar o alvo', () => {
  teste('FX-B01 — LINK SIMBÓLICO no lugar do diretório registrado: nada é removido e o ALVO do link NÃO muda de permissão (nem por `chmod` do gerenciador nem pela remoção)', { skip: ehRoot }, () => {
    const g = criarGerenciadorDeFixtures({ prefixo: 'gepi-fixt-b01-' });
    const d = g.criar();
    const alvo = vitima(0o755);
    fs.writeFileSync(path.join(alvo, 'precioso'), 'dados');
    fs.renameSync(d, `${d}-original`);
    fs.symlinkSync(alvo, d);
    assert.throws(() => g.chmod(d, 0o700), /LINK_SIMBOLICO/);
    assert.equal(modo(alvo), 0o755, 'o alvo do link manteve a permissão');
    const r = g.remover();
    assert.deepEqual(r.removidas, []);
    assert.deepEqual(r.ignoradas, [{ caminho: d, motivo: 'LINK_SIMBOLICO' }]);
    assert.equal(modo(alvo), 0o755);
    assert.equal(fs.readFileSync(path.join(alvo, 'precioso'), 'utf8'), 'dados');
    assert.equal(fs.lstatSync(d).isSymbolicLink(), true, 'o link não foi removido nem seguido');
    fs.unlinkSync(d);
    const h = criarGerenciadorDeFixtures({ prefixo: 'gepi-fixt-b01-' });
    h.adotar(`${d}-original`);
    assert.equal(h.remover().removidas.length, 1);
  });

  teste('FX-B02 — TROCA DE IDENTIDADE (mesmo caminho, outro inode): o substituto não é removido nem recebe `chmod`; o descritor guardado ainda aponta para o original, que não é alterado', { skip: ehRoot }, () => {
    const g = criarGerenciadorDeFixtures({ prefixo: 'gepi-fixt-b02-' });
    const d = g.criar();
    fs.renameSync(d, `${d}-original`);
    fs.mkdirSync(d, { mode: 0o755 });
    fs.writeFileSync(path.join(d, 'de-terceiro'), 'x');
    assert.throws(() => g.chmod(d, 0o700), /IDENTIDADE_DIVERGENTE/);
    assert.equal(modo(d), 0o755);
    const r = g.remover();
    assert.deepEqual(r.removidas, []);
    assert.deepEqual(r.ignoradas, [{ caminho: d, motivo: 'IDENTIDADE_DIVERGENTE' }]);
    assert.equal(existe(path.join(d, 'de-terceiro')), true);
    fs.rmSync(d, { recursive: true, force: true });
    const h = criarGerenciadorDeFixtures({ prefixo: 'gepi-fixt-b02-' });
    h.adotar(`${d}-original`);
    assert.equal(h.remover().removidas.length, 1);
  });

  teste('FX-B03 — HOMÔNIMO nunca registrado (mesmo prefixo) permanece; `chmod` de caminho não registrado é recusado', () => {
    const g = criarGerenciadorDeFixtures({ prefixo: 'gepi-fixt-b03-' });
    const meu = g.criar();
    const homonimo = fim.criar();
    const prefixoIgual = path.join(TMP, `gepi-fixt-b03-${process.pid}-terceiro`);
    fs.mkdirSync(prefixoIgual, { mode: 0o700 });
    try {
      assert.throws(() => g.chmod(prefixoIgual, 0o777), /não registrado/);
      assert.deepEqual(g.remover().removidas, [meu]);
      assert.equal(existe(prefixoIgual), true);
      assert.equal(existe(homonimo), true);
    } finally { fs.rmdirSync(prefixoIgual); }
  });

  teste('FX-B04 — diretório que foi APAGADO por fora some do registro sem erro; diretório registrado e depois movido para fora de tmp (rename) é recusado', () => {
    const g = criarGerenciadorDeFixtures({ prefixo: 'gepi-fixt-b04-' });
    const a = g.criar();
    fs.rmdirSync(a);
    assert.deepEqual(g.remover(), { removidas: [], ignoradas: [] });
    const b = g.criar();
    const fora = path.join(b, 'dentro');
    fs.mkdirSync(fora);
    assert.throws(() => g.renomeado(b, fora), /fora da raiz permitida/);
    assert.deepEqual(g.remover().removidas, [b]);
  });
});
