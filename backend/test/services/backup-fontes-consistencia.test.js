'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const K = require('../../src/services/backup-fontes-consistencia.service');

/** D-ORF-6, P7 — consistência cruzada banco × arquivos (R2 11.2–11.4): tudo puro. */

const hex = (c) => c.repeat(64);
const ref = (chave, sha256, bytes, empresaId) => ({ chave, sha256, bytes, empresaId });
const arq = (chave, sha256, bytes) => ({ chave, sha256, bytes });
const REFS = [ref('7/pacote-1.zip', hex('a'), 10, '7'), ref('7/pacote-2.zip', hex('b'), 20, '7'), ref('9/pacote-3.zip', hex('c'), 30, '9'), ref(`padrao/${hex('d')}/mestre.png`, hex('d'), 40, null)];
const ARQS = REFS.map((r) => arq(r.chave, r.sha256, r.bytes));

describe('[CX] conciliação por fonte (11.4 passo 4, M-ISO)', () => {
  test('CX-01 — íntegro: cada linha tem arquivo com hash e tamanho, cada arquivo tem linha, prefixo = empresa_id, contagens por empresa', () => {
    const r = K.conciliarFonte({ referencias: REFS, arquivos: [...ARQS].reverse(), regraEmpresa: 'SEGMENTO_INICIAL_DA_CHAVE' });
    assert.equal(r.classe, 'INTEGRO');
    assert.deepEqual(r.divergencias, []);
    assert.deepEqual(r.contagensPorEmpresa, { 7: { referencias: 2, arquivos: 2 }, 9: { referencias: 1, arquivos: 1 }, GLOBAL: { referencias: 1, arquivos: 1 } });
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.divergencias));
  });

  test('CX-02 — toda divergência sai nomeada e ligada à matriz: ausente (F2) => INCOMPLETO; extra (F5), hash (F10), tamanho (F10), empresa (F11), duplicada (F4) => INCONSISTENTE', () => {
    const semUm = K.conciliarFonte({ referencias: REFS, arquivos: ARQS.slice(1), regraEmpresa: 'SEGMENTO_INICIAL_DA_CHAVE' });
    assert.equal(semUm.classe, 'INCOMPLETO');
    assert.deepEqual(semUm.divergencias, [{ chave: '7/pacote-1.zip', codigo: 'ARQUIVO_AUSENTE', falha: 'F2' }]);
    assert.equal(semUm.ausentes, 1);
    const extra = K.conciliarFonte({ referencias: REFS, arquivos: [...ARQS, arq('7/pacote-9.zip', hex('e'), 1)], regraEmpresa: 'SEGMENTO_INICIAL_DA_CHAVE' });
    assert.equal(extra.classe, 'INCONSISTENTE');
    assert.deepEqual(extra.divergencias, [{ chave: '7/pacote-9.zip', codigo: 'ARQUIVO_EXTRA', falha: 'F5' }]);
    const hash = K.conciliarFonte({ referencias: REFS, arquivos: ARQS.map((a, i) => (i === 0 ? { ...a, sha256: hex('f') } : a)), regraEmpresa: null });
    assert.deepEqual(hash.divergencias.map((d) => [d.codigo, d.falha]), [['SHA256_DIVERGENTE', 'F10']]);
    const tamanho = K.conciliarFonte({ referencias: REFS, arquivos: ARQS.map((a, i) => (i === 1 ? { ...a, bytes: 21 } : a)), regraEmpresa: null });
    assert.deepEqual(tamanho.divergencias.map((d) => [d.codigo, d.falha]), [['TAMANHO_DIVERGENTE', 'F10']]);
    const empresa = K.conciliarFonte({ referencias: REFS.map((r, i) => (i === 2 ? { ...r, empresaId: '7' } : r)), arquivos: ARQS, regraEmpresa: 'SEGMENTO_INICIAL_DA_CHAVE' });
    assert.equal(empresa.classe, 'INCONSISTENTE');
    assert.deepEqual(empresa.divergencias, [{ chave: '9/pacote-3.zip', codigo: 'EMPRESA_DIVERGENTE', falha: 'F11' }]);
    const semRegra = K.conciliarFonte({ referencias: REFS.map((r, i) => (i === 2 ? { ...r, empresaId: '7' } : r)), arquivos: ARQS, regraEmpresa: null });
    assert.equal(semRegra.classe, 'INTEGRO', 'sem regra de prefixo não há M-ISO por chave');
    const dup = K.conciliarFonte({ referencias: [...REFS, REFS[0]], arquivos: ARQS, regraEmpresa: null });
    assert.deepEqual(dup.divergencias.map((d) => d.codigo), ['CHAVE_DUPLICADA']);
    const ausenteEExtra = K.conciliarFonte({ referencias: REFS, arquivos: [...ARQS.slice(1), arq('7/pacote-9.zip', hex('e'), 1)], regraEmpresa: null });
    assert.equal(ausenteEExtra.classe, 'INCONSISTENTE', 'ausência junto de outra divergência não é só INCOMPLETO');
  });

  test('CX-03 — teto de divergências (200) nunca silencia: truncadas é contado e a classe vira INCONSISTENTE; entradas inválidas são TypeError', () => {
    const muitas = Array.from({ length: 250 }, (_, i) => ref(`7/pacote-${i + 1}.zip`, hex('a'), 1, '7'));
    const r = K.conciliarFonte({ referencias: muitas, arquivos: [], regraEmpresa: null });
    assert.equal(r.divergencias.length, 200);
    assert.equal(r.truncadas, 50);
    assert.equal(r.classe, 'INCONSISTENTE');
    assert.throws(() => K.conciliarFonte({ referencias: [{ chave: 'x', sha256: 'curto', bytes: 1, empresaId: null }], arquivos: [], regraEmpresa: null }), (e) => e.code === 'ENTRADA_INVALIDA');
    assert.throws(() => K.conciliarFonte({ referencias: REFS, arquivos: ARQS, regraEmpresa: 'OUTRA' }), (e) => e.code === 'ENTRADA_INVALIDA');
    assert.throws(() => K.conciliarFonte({ referencias: REFS, arquivos: ARQS, extra: 1 }), (e) => e.code === 'ENTRADA_INVALIDA');
  });
});

describe('[PR] ponto de recuperação único, matriz e ordem (11.2–11.4)', () => {
  test('PR-01 — todas as leituras no mesmo snapshot e banco => único; qualquer divergência é nomeada', () => {
    const banco = { nome: 'gepi', oid: '16384' };
    const ok = K.pontoDeRecuperacao({ snapshotId: '00000003-00000002-1', banco, leituras: [{ fonteId: 'imagens', snapshotId: '00000003-00000002-1', banco }, { fonteId: 'fiscalizacao-pacotes', snapshotId: '00000003-00000002-1', banco }] });
    assert.deepEqual(ok, { unico: true, snapshotId: '00000003-00000002-1', fontes: ['fiscalizacao-pacotes', 'imagens'], divergentes: [], motivo: null });
    const ruim = K.pontoDeRecuperacao({ snapshotId: '00000003-00000002-1', banco, leituras: [{ fonteId: 'imagens', snapshotId: '00000003-00000002-2', banco }, { fonteId: 'postgres-aplicacao', snapshotId: '00000003-00000002-1', banco: { nome: 'outro', oid: '1' } }] });
    assert.equal(ruim.unico, false);
    assert.deepEqual(ruim.divergentes, ['imagens', 'postgres-aplicacao']);
    assert.equal(ruim.motivo, 'PONTO_DE_RECUPERACAO_DIVERGENTE');
    assert.throws(() => K.pontoDeRecuperacao({ snapshotId: 'x', banco, leituras: [] }), (e) => e.code === 'ENTRADA_INVALIDA');
  });

  test('PR-02 — matriz F1..F13 completa, congelada, com efeito e tratamento; cada divergência observada aponta uma falha', () => {
    assert.deepEqual(K.MATRIZ_DE_FALHAS.map((f) => f.id), Array.from({ length: 13 }, (_, i) => `F${i + 1}`));
    assert.ok(K.MATRIZ_DE_FALHAS.every((f) => Object.isFrozen(f) && f.falha && f.efeito && f.tratamento));
    assert.equal(K.MATRIZ_DE_FALHAS[12].tratamento, 'ACH_FISC_01_CORRIGIDO_FONTE_PROTEGIDA');
    for (const [codigo, falha] of Object.entries(K.DIVERGENCIA_PARA_FALHA)) assert.ok(K.MATRIZ_DE_FALHAS.some((f) => f.id === falha), codigo);
    assert.equal(K.classificarDivergencia('ESQUEMA_A_FRENTE_DO_CODIGO'), 'F12');
    assert.equal(K.classificarDivergencia('INVENTADA'), null);
  });

  test('PR-03 — ordem obrigatória: passos só na sequência, falha trava o resto, nunca recuperavelEmProducao; avaliação consolida fontes e esquema', () => {
    const o = K.criarOrdemDeRestauracao();
    assert.deepEqual(o.registrar('VERIFICACOES_8_7', { ok: true }), { aceito: false, motivo: 'PASSO_FORA_DE_ORDEM', passo: 'VERIFICACOES_8_7', esperado: 'DESTINO_NOVO' });
    assert.equal(o.registrar('DESTINO_NOVO', { ok: true }).aceito, true);
    assert.equal(o.registrar('DESTINO_NOVO', { ok: true }).motivo, 'PASSO_FORA_DE_ORDEM');
    assert.equal(o.registrar('VERIFICACOES_8_7', { ok: false }).motivo, 'PASSO_FALHOU');
    assert.equal(o.registrar('BANCO_E_ESQUEMA', { ok: true }).motivo, 'RESTAURACAO_JA_FALHOU');
    assert.deepEqual(o.situacao(), { concluidos: ['DESTINO_NOVO'], proximo: null, falhou: 'VERIFICACOES_8_7', completa: false, recuperavelEmProducao: false });
    const completa = K.criarOrdemDeRestauracao();
    for (const p of K.PASSOS) assert.equal(completa.registrar(p, { ok: true }).aceito, true);
    assert.equal(completa.situacao().completa, true);
    assert.throws(() => completa.registrar('OUTRO', { ok: true }), (e) => e.code === 'ENTRADA_INVALIDA');

    const integro = K.avaliarRestauracao({ fontes: { imagens: { classe: 'INTEGRO' }, 'fiscalizacao-pacotes': { classe: 'INTEGRO' } }, esquema: { relacao: 'IGUAL' }, ordem: completa.situacao() });
    assert.deepEqual(integro, { classe: 'INTEGRO', motivos: [], recuperavelEmProducao: false, restauracaoReal: false });
    const incompleta = K.avaliarRestauracao({ fontes: { imagens: { classe: 'INCOMPLETO' } }, esquema: { relacao: 'IGUAL' }, ordem: completa.situacao() });
    assert.deepEqual([incompleta.classe, incompleta.motivos], ['INCOMPLETO', ['FONTE_INCOMPLETA:imagens']]);
    const esquema = K.avaliarRestauracao({ fontes: { imagens: { classe: 'INTEGRO' } }, esquema: { relacao: 'BANCO_A_FRENTE_DO_CODIGO' }, ordem: o.situacao() });
    assert.deepEqual([esquema.classe, esquema.motivos], ['INCONSISTENTE', ['ESQUEMA_BANCO_A_FRENTE_DO_CODIGO', 'ORDEM_NAO_CONCLUIDA']]);
    const domina = K.avaliarRestauracao({ fontes: { a: { classe: 'INCOMPLETO' }, b: { classe: 'INCONSISTENTE' } }, esquema: { relacao: 'IGUAL' }, ordem: completa.situacao() });
    assert.equal(domina.classe, 'INCONSISTENTE');
  });
});
