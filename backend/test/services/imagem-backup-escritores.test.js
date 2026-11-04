'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { inspecionarArmazenamento, fotografar, avaliarConsistencia, GARANTIA_CONTRA_ESCRITORES_EXTERNOS, CONTROLES_EXTERNOS_APROVADOS, REQUISITOS_EXTERNOS, ESCRITORES_CONHECIDOS } = require('../../src/services/imagem-backup-escritores.service');
const { criarGerenciadorDeFixtures } = require('../helpers/fixtures-descartaveis');

/** Escritores externos: inspeção e detecção sobre árvores temporárias do teste. Detectar não é impedir; a garantia exige controle externo. */

const teste = (nome, fn) => test(nome, { timeout: 30000 }, fn);
const uid = process.getuid();
// Teardown por IDENTIDADE (descritor guardado na criação), nunca por prefixo (ver helpers/fixtures-descartaveis.js)
const fix = criarGerenciadorDeFixtures({ prefixo: 'gepi-esc-test-' });
after(() => { fix.remover(); });
function arvore() {
  const r = fix.criar();
  fs.mkdirSync(path.join(r, 'aa'), { mode: 0o700 });
  fs.writeFileSync(path.join(r, 'aa', 'um'), 'um', { mode: 0o600 });
  fs.writeFileSync(path.join(r, 'aa', 'dois'), 'dois', { mode: 0o600 });
  return r;
}
const insp = (raiz, extra = {}) => inspecionarArmazenamento({ raiz, uidsAutorizados: [uid], ...extra });

describe('[ES-A] garantia contra escritores externos NÃO comprovada por código', () => {
  teste('ES-A01 — a garantia é sempre NAO_COMPROVADA, a lista de controles externos é vazia e os requisitos externos ficam explícitos; os escritores conhecidos estão classificados', () => {
    assert.equal(GARANTIA_CONTRA_ESCRITORES_EXTERNOS, 'NAO_COMPROVADA');
    assert.deepEqual([...CONTROLES_EXTERNOS_APROVADOS], []);
    assert.ok(REQUISITOS_EXTERNOS.includes('COORDENACAO_ENTRE_HOSPEDEIROS') && REQUISITOS_EXTERNOS.includes('NENHUM_OUTRO_PRINCIPAL_COM_ESCRITA'));
    assert.equal(ESCRITORES_CONHECIDOS.GRAVACAO_DO_ARMAZENAMENTO, 'ADITIVA_SEM_JANELA');
    assert.equal(ESCRITORES_CONHECIDOS.OUTRA_INSTANCIA_OU_HOSPEDEIRO, 'JANELA_LOCAL_NAO_VALE_ENTRE_HOSPEDEIROS');
    const r = insp(arvore());
    assert.deepEqual([r.conforme, r.garantiaContraEscritoresExternos], [true, 'NAO_COMPROVADA']);
  });
});

describe('[ES-B] inspeção de propriedade e permissões', () => {
  teste('ES-B01 — árvore do usuário autorizado, sem escrita para terceiros e sem links: conforme (sem comprovar exclusão)', () => {
    const r = insp(arvore());
    assert.deepEqual([r.conforme, r.inconclusivo, r.entradas, { ...r.violacoes }], [true, false, 3, {}]);
  });

  teste('ES-B02 — escrita para grupo/outros, link simbólico, dono não autorizado e tipo especial são violações contadas, sem caminho', () => {
    const r = arvore();
    fs.chmodSync(path.join(r, 'aa', 'um'), 0o666);
    fs.symlinkSync('/etc/hosts', path.join(r, 'aa', 'ln'));
    const resultado = insp(r);
    assert.equal(resultado.conforme, false);
    assert.deepEqual({ ...resultado.violacoes }, { ESCRITA_PARA_GRUPO_OU_OUTROS: 1, LINK_SIMBOLICO: 1 });
    assert.equal(JSON.stringify(resultado).includes(r), false);
    const outroDono = insp(arvore(), { });
    assert.equal(outroDono.conforme, true);
    const estranho = inspecionarArmazenamento({ raiz: arvore(), uidsAutorizados: [uid + 100000] });
    assert.equal(estranho.conforme, false);
    assert.ok(estranho.violacoes.DONO_NAO_AUTORIZADO >= 3);
  });

  teste('ES-B03 — raiz inexistente, link ou arquivo: inconclusivo/violação; limite de entradas estourado => INCONCLUSIVO (nunca conforme); entrada malformada recusada', () => {
    const r = arvore();
    const ausente = insp(path.join(r, 'nao-existe'));
    assert.deepEqual([ausente.conforme, ausente.inconclusivo], [false, true]);
    const ln = path.join(r, 'link-raiz');
    fs.symlinkSync(r, ln);
    assert.equal(insp(ln).conforme, false);
    assert.equal(insp(path.join(r, 'aa', 'um')).conforme, false);
    const curto = insp(r, { limite: 2 });
    assert.deepEqual([curto.conforme, curto.inconclusivo], [false, true]);
    for (const ruim of [null, {}, { raiz: 'relativo', uidsAutorizados: [uid] }, { raiz: r, uidsAutorizados: [] }, { raiz: r, uidsAutorizados: [uid], limite: 0 }, { raiz: r, uidsAutorizados: [uid], extra: 1 }]) assert.throws(() => inspecionarArmazenamento(ruim), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });
});

describe('[ES-C] detecção de alteração concorrente (antes x depois)', () => {
  teste('ES-C01 — sem mudança é consistente; adição é permitida e sinalizada', () => {
    const r = arvore();
    const antes = fotografar({ raiz: r });
    assert.deepEqual({ ...avaliarConsistencia(antes, fotografar({ raiz: r })) }, { consistente: true, motivo: null, adicionados: 0, removidos: 0, modificados: 0 });
    fs.writeFileSync(path.join(r, 'aa', 'novo'), 'novo', { mode: 0o600 });
    assert.deepEqual({ ...avaliarConsistencia(antes, fotografar({ raiz: r })) }, { consistente: true, motivo: 'SOMENTE_ADICOES', adicionados: 1, removidos: 0, modificados: 0 });
  });

  teste('ES-C02 — remoção, modificação (conteúdo/tamanho) e substituição por outro arquivo são ALTERAÇÃO_CONCORRENTE', () => {
    for (const mexer of [
      (r) => fs.unlinkSync(path.join(r, 'aa', 'um')),
      (r) => fs.appendFileSync(path.join(r, 'aa', 'um'), 'x'),
      (r) => { fs.unlinkSync(path.join(r, 'aa', 'dois')); fs.writeFileSync(path.join(r, 'aa', 'dois'), 'dois', { mode: 0o600 }); },
      (r) => fs.rmSync(path.join(r, 'aa'), { recursive: true }),
    ]) {
      const r = arvore();
      const antes = fotografar({ raiz: r });
      mexer(r);
      const a = avaliarConsistencia(antes, fotografar({ raiz: r }));
      assert.deepEqual([a.consistente, a.motivo], [false, 'ALTERACAO_CONCORRENTE']);
    }
  });

  teste('ES-C03 — fotografia incompleta ou inválida é inconclusiva e NUNCA consistente', () => {
    const r = arvore();
    const completa = fotografar({ raiz: r });
    const curta = fotografar({ raiz: r, limite: 1 });
    assert.equal(curta.completa, false);
    assert.deepEqual([avaliarConsistencia(completa, curta).consistente, avaliarConsistencia(curta, completa).motivo], [false, 'FOTOGRAFIA_INCOMPLETA']);
    for (const ruim of [null, {}, { itens: new Map() }, 'x']) assert.deepEqual([avaliarConsistencia(ruim, completa).consistente, avaliarConsistencia(completa, ruim).motivo], [false, 'FOTOGRAFIA_INVALIDA']);
    assert.throws(() => fotografar({ raiz: 'relativo' }), (e) => e.code === 'CONFIGURACAO_INVALIDA');
  });

  teste('ES-C04 — LIMITE DETERMINÍSTICO: conteúdo trocado por outro de MESMO tamanho, no mesmo inode e com o mtime restaurado em segundos inteiros, NÃO é visto pela impressão digital (detectar não é impedir)', () => {
    const r = arvore();
    const alvo = path.join(r, 'aa', 'um');
    // mtime em segundos inteiros: exatamente representável (em ms) em qualquer sistema de arquivos com resolução >= 1 ms; a pré-condição é AFIRMADA, não pulada
    const T = 1_700_000_000;
    fs.utimesSync(alvo, T, T);
    const antes = fotografar({ raiz: r });
    assert.equal(antes.itens.get('aa/um').mtime, T * 1000, 'pré-condição: o sistema de arquivos guarda o mtime pedido');
    const original = fs.readFileSync(alvo, 'utf8');
    const diferente = 'ab';
    assert.equal(diferente.length, original.length);
    assert.notEqual(diferente, original);
    const inodeAntes = fs.statSync(alvo).ino;
    fs.writeFileSync(alvo, diferente); // mesmo inode, mesmo tamanho
    fs.utimesSync(alvo, T, T);
    assert.equal(fs.statSync(alvo).ino, inodeAntes);
    assert.equal(fs.readFileSync(alvo, 'utf8'), diferente, 'o conteúdo MUDOU de verdade');
    const depois = fotografar({ raiz: r });
    assert.deepEqual({ ...avaliarConsistencia(antes, depois) }, { consistente: true, motivo: null, adicionados: 0, removidos: 0, modificados: 0 });
  });
});
