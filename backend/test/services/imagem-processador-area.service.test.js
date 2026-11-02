'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * D-12 — ÁREA TEMPORÁRIA EXCLUSIVA do processador de imagens (src/services/imagem-processador-area.service.js): criação privada e exclusiva,
 * inventário das sobras e remoção que só alcança o diretório criado, sem seguir links e sem tocar em terceiros. Tudo roda dentro de uma base
 * descartável criada por este arquivo abaixo da pasta temporária do sistema; nada fora dela é lido ou escrito.
 */

const A = require('../../src/services/imagem-processador-area.service');

let base;
before(() => { base = fs.mkdtempSync(path.join(os.tmpdir(), 'gepi-area-teste-')); });
after(() => { fs.rmSync(base, { recursive: true, force: true }); });

const existe = (c) => { try { fs.lstatSync(c); return true; } catch { return false; } };

describe('criarAreaExclusiva', () => {
  test('A-01 — cria um diretório privado (0700), com o prefixo, abaixo da base, e devolve o token com dispositivo, inode e dono', () => {
    const area = A.criarAreaExclusiva({ base });
    assert.equal(path.dirname(area.caminho), base);
    assert.ok(path.basename(area.caminho).startsWith(A.PREFIXO));
    const st = fs.lstatSync(area.caminho);
    assert.ok(st.isDirectory());
    assert.equal(st.mode & 0o777, 0o700);
    assert.deepEqual([area.dev, area.ino, area.uid], [Number(st.dev), Number(st.ino), Number(st.uid)]);
    assert.ok(Object.isFrozen(area));
    const outra = A.criarAreaExclusiva({ base });
    assert.notEqual(outra.caminho, area.caminho);
    assert.notEqual(outra.ino, area.ino);
  });

  test('A-02 — base relativa é erro de programação; base inexistente falha sem criar nada', () => {
    assert.throws(() => A.criarAreaExclusiva({ base: 'relativa' }), TypeError);
    assert.throws(() => A.criarAreaExclusiva({ base: path.join(base, 'nao-existe') }), (e) => e.code === 'ENOENT');
  });

  test('A-03 — o padrão é a pasta temporária do sistema', () => {
    const area = A.criarAreaExclusiva();
    try { assert.equal(fs.realpathSync.native(path.dirname(area.caminho)), fs.realpathSync.native(os.tmpdir())); } finally { fs.rmSync(area.caminho, { recursive: true }); }
  });
});

describe('removerAreaExclusiva', () => {
  test('A-04 — área vazia: removida, sem sobras', () => {
    const area = A.criarAreaExclusiva({ base });
    assert.deepEqual(A.removerAreaExclusiva(area), { removida: true, motivo: null, sobras: [], truncado: false });
    assert.ok(!existe(area.caminho));
  });

  test('A-05 — sobras (arquivo, subpasta, link) são inventariadas e removidas; o alvo do link NÃO é tocado', () => {
    const vitima = path.join(base, 'vitima-a05');
    fs.mkdirSync(vitima);
    fs.writeFileSync(path.join(vitima, 'intocada.txt'), 'fica');
    const area = A.criarAreaExclusiva({ base });
    fs.writeFileSync(path.join(area.caminho, 'sobra.bin'), Buffer.alloc(2048, 7));
    fs.mkdirSync(path.join(area.caminho, 'sub'));
    fs.writeFileSync(path.join(area.caminho, 'sub', 'interna.tmp'), 'x');
    fs.symlinkSync(vitima, path.join(area.caminho, 'ligacao'));
    fs.symlinkSync(path.join(vitima, 'intocada.txt'), path.join(area.caminho, 'sub', 'ligacao-arquivo'));
    const r = A.removerAreaExclusiva(area);
    assert.equal(r.removida, true);
    assert.deepEqual(r.sobras, [
      { caminho: 'ligacao', tipo: 'link', bytes: null }, { caminho: 'sobra.bin', tipo: 'arquivo', bytes: 2048 }, { caminho: 'sub', tipo: 'diretorio', bytes: null },
      { caminho: 'sub/interna.tmp', tipo: 'arquivo', bytes: 1 }, { caminho: 'sub/ligacao-arquivo', tipo: 'link', bytes: null },
    ]);
    assert.ok(!existe(area.caminho));
    assert.equal(fs.readFileSync(path.join(vitima, 'intocada.txt'), 'utf8'), 'fica');
  });

  test('A-06 — token inválido é erro de programação; token com o caminho de OUTRO diretório não remove nada (TROCADA)', () => {
    for (const ruim of [null, {}, { caminho: 'relativo', dev: 1, ino: 1, uid: 1 }, { caminho: path.join(base, 'sem-prefixo'), dev: 1, ino: 1, uid: 1 }]) assert.throws(() => A.removerAreaExclusiva(ruim), TypeError);
    const area = A.criarAreaExclusiva({ base });
    const alheia = path.join(base, `${A.PREFIXO}alheia`);
    fs.mkdirSync(alheia);
    fs.writeFileSync(path.join(alheia, 'dado.txt'), 'de terceiro');
    assert.deepEqual(A.removerAreaExclusiva({ ...area, caminho: alheia }), { removida: false, motivo: 'TROCADA', sobras: [], truncado: false });
    assert.equal(fs.readFileSync(path.join(alheia, 'dado.txt'), 'utf8'), 'de terceiro');
    assert.equal(A.removerAreaExclusiva(area).removida, true);
  });

  test('A-07 — caminho trocado por link simbólico entre a criação e a remoção: nada é removido, o link fica e o alvo permanece intacto', () => {
    const vitima = path.join(base, 'vitima-a07');
    fs.mkdirSync(vitima);
    fs.writeFileSync(path.join(vitima, 'intocada.txt'), 'fica');
    const area = A.criarAreaExclusiva({ base });
    fs.rmdirSync(area.caminho);
    fs.symlinkSync(vitima, area.caminho);
    assert.deepEqual(A.removerAreaExclusiva(area), { removida: false, motivo: 'TROCADA', sobras: [], truncado: false });
    assert.ok(fs.lstatSync(area.caminho).isSymbolicLink());
    assert.equal(fs.readFileSync(path.join(vitima, 'intocada.txt'), 'utf8'), 'fica');
    fs.unlinkSync(area.caminho);
  });

  test('A-08 — diretório recriado com o mesmo nome (inode diferente) também é TROCADA; já removida é INEXISTENTE', () => {
    const area = A.criarAreaExclusiva({ base });
    fs.rmdirSync(area.caminho);
    assert.equal(A.removerAreaExclusiva(area).motivo, 'INEXISTENTE');
    fs.mkdirSync(area.caminho);
    fs.writeFileSync(path.join(area.caminho, 'de-outro.txt'), 'x');
    assert.equal(A.removerAreaExclusiva(area).motivo, 'TROCADA');
    assert.ok(existe(path.join(area.caminho, 'de-outro.txt')));
    fs.rmSync(area.caminho, { recursive: true });
  });

  test('A-09 — o inventário tem teto: muitas sobras marcam truncado, e mesmo assim tudo é removido', () => {
    const area = A.criarAreaExclusiva({ base });
    for (let i = 0; i < A.SOBRAS_MAX + 20; i += 1) fs.writeFileSync(path.join(area.caminho, `s${String(i).padStart(4, '0')}`), '');
    const r = A.removerAreaExclusiva(area);
    assert.deepEqual([r.removida, r.truncado, r.sobras.length], [true, true, A.SOBRAS_MAX]);
    assert.ok(!existe(area.caminho));
  });
});
