'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const K = require('../../src/services/backup-fontes-custodia-chaves.service');
const E = require('../../src/services/backup-fontes-cifra-envelope.service');
const H = require('../../src/services/imagem-backup-manifesto-autenticado.service');

/** D-ORF-6, P11 — política de custódia (RC-1..RC-10, D-F4..D-F7): avaliação pura; nenhuma chave real, nenhuma pendência presumida resolvida. */

const fonteMac = () => H.criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'mac-1', segredo: crypto.randomBytes(32) }] });
const fonteCifra = () => E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'kek-1', segredo: crypto.randomBytes(32) }] });
const AGORA = new Date('2026-11-03T12:00:00Z');
const declaracaoCompleta = () => ({
  cifra: { fonte: fonteCifra(), chaveId: 'kek-1' }, mac: { fonte: fonteMac(), chaveId: 'mac-1' },
  custodia: { temporariosProtegidos: 'DISCO_CIFRADO', copias: [{ local: 'cofre-a' }, { local: 'cofre-b' }], periodicidadeDias: 90, ultimoEnsaioDeRecuperacaoEm: '2026-10-01', escopoDaChave: 'GLOBAL', disponivelEmDesastre: true, rotacaoEnsaiada: true, cifraNoPacote: true, metadadosVisiveisAceitos: true },
  retencao: { politica: 'ROTATIVA', aprovadaPeloDpo: true }, transporte: { tlsVerifyFull: true }, agora: AGORA,
});

describe('[KC] prontidão criptográfica', () => {
  test('KC-01 — mesmo com tudo declarado, as listas aprovadas vazias (D-F4/D-F5) mantêm dados reais PROIBIDOS; pendências residuais são exatamente as decisões de Ramires', () => {
    const r = K.avaliarProntidaoCriptografica(declaracaoCompleta());
    assert.equal(r.dadosReaisPermitidos, false);
    assert.deepEqual(r.pendencias.map((p) => `${p.requisito}:${p.codigo}`), [
      'D-F5:FONTE_DE_CIFRA_NAO_OPERACIONAL', 'D-F5:FONTE_DE_MAC_NAO_OPERACIONAL', 'D-F5:PROVEDOR_DE_MAC_NAO_APROVADO', 'D-F5:PROVEDOR_DE_CIFRA_NAO_APROVADO',
      'RC-2:DESTINO_DURAVEL_NAO_APROVADO', 'RC-2:DESTINO_LOCAL_NAO_AUTORIZADO',
    ]);
    assert.deepEqual(r.atendidos, ['RC-1', 'RC-3', 'RC-4', 'RC-5', 'RC-6', 'RC-7', 'RC-8', 'RC-9', 'RC-10', 'D-F4', 'D-F6', 'D-F7']);
    assert.deepEqual(Object.keys(r.porRequisito), [...K.REQUISITOS]);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.pendencias));
  });

  test('KC-02 — sem nenhuma declaração: todas as pendências aparecem com códigos fixos (falha fechada)', () => {
    const r = K.avaliarProntidaoCriptografica({ cifra: null, mac: null, custodia: null, retencao: null, transporte: null, agora: AGORA });
    assert.equal(r.dadosReaisPermitidos, false);
    assert.deepEqual(r.atendidos, ['RC-7', 'D-F7']);
    const codigos = r.pendencias.map((p) => p.codigo);
    for (const c of ['FONTE_DE_CIFRA_AUSENTE', 'FONTE_DE_MAC_AUSENTE', 'TEMPORARIOS_NAO_PROTEGIDOS', 'COPIAS_INSUFICIENTES', 'PERIODICIDADE_NAO_DEFINIDA', 'ESCOPO_DA_CHAVE_NAO_DEFINIDO', 'CUSTODIA_INDISPONIVEL_EM_DESASTRE', 'ROTACAO_NAO_ENSAIADA', 'CIFRA_NO_PACOTE_NAO_ADOTADA', 'TRANSPORTE_SEM_TLS_VERIFY_FULL', 'METADADOS_VISIVEIS_NAO_DECIDIDOS', 'POLITICA_DE_RETENCAO_NAO_DEFINIDA', 'RETENCAO_SEM_DPO']) assert.ok(codigos.includes(c), c);
  });

  test('KC-03 — pendências específicas: chaves não separadas, cópia no host de backup, ensaio vencido/ausente, TLS ausente, retenção sem DPO', () => {
    const d = declaracaoCompleta();
    const so = (mut) => { const x = declaracaoCompleta(); mut(x); return K.avaliarProntidaoCriptografica(x).pendencias.map((p) => p.codigo); };
    assert.ok(so((x) => { x.mac = { fonte: x.cifra.fonte, chaveId: 'kek-1' }; }).includes('FONTE_DE_MAC_AUSENTE'), 'fonte de cifra no lugar da de MAC não é aceita');
    assert.ok(so((x) => { x.mac.chaveId = 'kek-1'; }).includes('CHAVES_NAO_SEPARADAS'));
    assert.ok(so((x) => { x.custodia.copias = [{ local: 'a' }, { local: 'b', noHostDeBackup: true }]; }).includes('COPIA_NO_HOST_DE_BACKUP'));
    assert.ok(so((x) => { x.custodia.copias = [{ local: 'a' }, { local: 'a' }]; }).includes('COPIAS_INSUFICIENTES'));
    assert.ok(so((x) => { x.custodia.ultimoEnsaioDeRecuperacaoEm = '2026-07-01'; }).includes('ENSAIO_DE_RECUPERACAO_VENCIDO'));
    assert.ok(so((x) => { delete x.custodia.ultimoEnsaioDeRecuperacaoEm; }).includes('ENSAIO_DE_RECUPERACAO_AUSENTE'));
    assert.ok(so((x) => { x.transporte = { tlsVerifyFull: 'true' }; }).includes('TRANSPORTE_SEM_TLS_VERIFY_FULL'));
    assert.ok(so((x) => { x.retencao = { politica: 'ROTATIVA' }; }).includes('RETENCAO_SEM_DPO'));
    assert.ok(so((x) => { x.custodia.escopoDaChave = 'POR_USUARIO'; }).includes('ESCOPO_DA_CHAVE_NAO_DEFINIDO'));
    assert.throws(() => K.avaliarProntidaoCriptografica({ ...d, extra: 1 }), (e) => e.code === 'ENTRADA_INVALIDA');
    assert.throws(() => K.avaliarProntidaoCriptografica({ ...d, agora: 'hoje' }), (e) => e.code === 'ENTRADA_INVALIDA' && e.motivo === 'AGORA');
  });

  test('KC-04 — autorizarEnvioDuravel: recusa contêiner não cifrado, ambiente inválido e destino não aprovado (lista vazia hoje)', () => {
    assert.deepEqual(K.autorizarEnvioDuravel({ containerCifrado: { ok: false }, destinoId: 'x', ambiente: 'HOMOLOGACAO' }), { autorizado: false, motivo: 'CONTAINER_NAO_CIFRADO' });
    assert.deepEqual(K.autorizarEnvioDuravel({ containerCifrado: { ok: true, sha256Envelope: 'a'.repeat(64) }, destinoId: 'x', ambiente: 'CI' }), { autorizado: false, motivo: 'AMBIENTE_INVALIDO' });
    assert.deepEqual(K.autorizarEnvioDuravel({ containerCifrado: { ok: true, sha256Envelope: 'a'.repeat(64) }, destinoId: 'x', ambiente: 'PRODUCAO' }), { autorizado: false, motivo: 'DESTINO_DURAVEL_NAO_APROVADO' });
    assert.throws(() => K.autorizarEnvioDuravel({ containerCifrado: {}, destinoId: 'x', ambiente: 'HOMOLOGACAO', extra: 1 }), (e) => e.code === 'ENTRADA_INVALIDA');
  });
});
