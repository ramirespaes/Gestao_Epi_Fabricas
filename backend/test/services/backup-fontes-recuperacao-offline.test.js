'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const util = require('node:util');
const X = require('../../src/services/backup-custodia-xor.service');
const R = require('../../src/services/backup-fontes-recuperacao-offline.service');
const E = require('../../src/services/backup-fontes-cifra-envelope.service');
const H = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const Mm = require('../../src/services/backup-fontes-manifesto-l2.service');
const { verificarPacoteL2 } = require('../../src/services/backup-fontes-composicao-l2.service');
const { novaRaiz, limparRaizes, pacoteSintetico, arvore, sha } = require('../helpers/pacote-l2-sintetico');

/** R-D45 [OFF-P]: provedor de RECUPERAÇÃO OFF-LINE — monta as duas famílias de chaves a partir das partes de custódia, sem KMS, sem rede, só com dados SINTÉTICOS. */

after(limparRaizes);
const SEG_MAC = crypto.randomBytes(32);
const SEG_KEK = crypto.randomBytes(32);
const dMac = X.dividirSegredo({ chaveId: 'mac-hml-v1', segredo: SEG_MAC });
const dKek = X.dividirSegredo({ chaveId: 'kek-hml-v1', segredo: SEG_KEK });
const par = (d, i, j) => [d.pacotes[i], d.pacotes[j]];
const chaves = (i = 0, j = 1) => ({ mac: [{ chaveId: 'mac-hml-v1', estado: 'ATIVA', pacotes: par(dMac, i, j) }], cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', pacotes: par(dKek, i, j) }] });
const recusa = (fn, code, motivo) => assert.throws(fn, (e) => e.code === code && (motivo === undefined || e.motivo === motivo));

describe('[OFF-P] recuperação a partir das partes', () => {
  test('OFF-20 — qualquer dupla de custodiantes monta MAC e KEK; as famílias não se misturam; cópias independentes', () => {
    for (const [i, j] of [[0, 1], [1, 2], [0, 2], [2, 0]]) {
      const p = R.criarProvedoresDeRecuperacaoOffline({ chaves: chaves(i, j) });
      assert.equal(p.estado(), 'PRONTO');
      assert.ok(p.mac.obter('mac-hml-v1').segredo.equals(SEG_MAC));
      assert.ok(p.cifra.obter('kek-hml-v1').segredo.equals(SEG_KEK));
      assert.equal(p.mac.obter('kek-hml-v1').situacao, 'INDISPONIVEL');
      assert.equal(p.cifra.obter('mac-hml-v1').situacao, 'INDISPONIVEL');
      const copia = p.mac.obter('mac-hml-v1').segredo;
      copia.fill(0);
      assert.ok(p.mac.obter('mac-hml-v1').segredo.equals(SEG_MAC));
    }
  });

  test('OFF-21 — partes em texto, chave revogada sem partes, e zerar encerra o provedor', () => {
    const texto = (d, i, j) => [X.codificarPacote(d.pacotes[i]), X.codificarPacote(d.pacotes[j])];
    const p = R.criarProvedoresDeRecuperacaoOffline({ chaves: {
      mac: [{ chaveId: 'mac-hml-v1', estado: 'ATIVA', pacotes: texto(dMac, 2, 1) }, { chaveId: 'mac-hml-v0', estado: 'REVOGADA' }],
      cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', pacotes: texto(dKek, 0, 2) }],
    } });
    assert.ok(p.mac.obter('mac-hml-v1').segredo.equals(SEG_MAC));
    assert.deepEqual({ ...p.mac.obter('mac-hml-v0') }, { situacao: 'REVOGADA' });
    assert.equal(p.mac.obter('nao-existe').situacao, 'INDISPONIVEL');
    assert.equal(typeof p.mac.obter('mac-hml-v1').then, 'undefined', 'contrato SÍNCRONO');
    p.zerar();
    assert.equal(p.estado(), 'ZERADO');
    assert.equal(p.mac.obter('mac-hml-v1').situacao, 'INDISPONIVEL');
    assert.equal(p.cifra.obter('kek-hml-v1').situacao, 'INDISPONIVEL');
  });

  test('OFF-22 — falha fechada: uma só parte, chave trocada, MAC igual à KEK, KEK com tamanho errado, partes de outra divisão; nada é entregue', () => {
    const base = chaves();
    recusa(() => R.criarProvedoresDeRecuperacaoOffline({ chaves: { ...base, mac: [{ chaveId: 'mac-hml-v1', estado: 'ATIVA', pacotes: [dMac.pacotes[0]] }] } }), 'RECUPERACAO_OFFLINE_FALHOU', 'PACOTES_INSUFICIENTES');
    recusa(() => R.criarProvedoresDeRecuperacaoOffline({ chaves: { ...base, mac: [{ chaveId: 'mac-hml-v2', estado: 'ATIVA', pacotes: par(dMac, 0, 1) }] } }), 'RECUPERACAO_OFFLINE_FALHOU', 'CHAVE_DIFERENTE_DA_ESPERADA');
    const dIgual = X.dividirSegredo({ chaveId: 'kek-hml-v1', segredo: SEG_MAC });
    recusa(() => R.criarProvedoresDeRecuperacaoOffline({ chaves: { ...base, cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', pacotes: par(dIgual, 0, 1) }] } }), 'RECUPERACAO_OFFLINE_FALHOU', 'CHAVES_NAO_SEPARADAS');
    const dLonga = X.dividirSegredo({ chaveId: 'kek-hml-v1', segredo: crypto.randomBytes(40) });
    recusa(() => R.criarProvedoresDeRecuperacaoOffline({ chaves: { ...base, cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', pacotes: par(dLonga, 0, 1) }] } }), 'RECUPERACAO_OFFLINE_FALHOU', 'SEGREDO_INVALIDO');
    const dCurta = X.dividirSegredo({ chaveId: 'kek-hml-v1', segredo: SEG_KEK });
    recusa(() => R.criarProvedoresDeRecuperacaoOffline({ chaves: { ...base, cifra: [{ chaveId: 'kek-hml-v1', estado: 'ATIVA', pacotes: [dKek.pacotes[0], dCurta.pacotes[1]] }] } }), 'RECUPERACAO_OFFLINE_FALHOU', 'PARTE_DIVERGENTE');
  });

  test('OFF-23 — configuração inválida: chave extra, família vazia, sem chave ativa, id repetido entre famílias, estado inválido, revogada com partes', () => {
    const base = chaves();
    const ruim = (c) => recusa(() => R.criarProvedoresDeRecuperacaoOffline(c), 'CONFIGURACAO_INVALIDA');
    ruim(null);
    ruim({ chaves: base, extra: 1 });
    ruim({ chaves: { mac: base.mac } });
    ruim({ chaves: { ...base, cifra: [] } });
    ruim({ chaves: { ...base, mac: [{ chaveId: 'mac-hml-v0', estado: 'REVOGADA' }] } });
    ruim({ chaves: { ...base, cifra: [{ ...base.cifra[0], chaveId: 'mac-hml-v1' }] } });
    ruim({ chaves: { ...base, mac: [{ ...base.mac[0], estado: 'PAUSADA' }] } });
    ruim({ chaves: { ...base, mac: [...base.mac, { chaveId: 'mac-hml-v0', estado: 'REVOGADA', pacotes: par(dMac, 0, 1) }] } });
    ruim({ chaves: { ...base, mac: [{ ...base.mac[0], extra: 1 }] } });
  });

  test('OFF-24 — nada vaza: JSON, inspeção e erros não contêm segredo nem partes; o módulo não usa arquivo, rede, ambiente nem entrada padrão', () => {
    const p = R.criarProvedoresDeRecuperacaoOffline({ chaves: chaves() });
    const material = [SEG_MAC, SEG_KEK].flatMap((s) => [s.toString('hex'), s.toString('base64')]).concat([...dMac.pacotes, ...dKek.pacotes].flatMap((k) => k.partes.map((x) => x.valor)));
    for (const texto of [JSON.stringify(p), JSON.stringify(p.mac), util.inspect(p, { showHidden: true, depth: 6 })]) for (const m of material) assert.equal(texto.includes(m), false);
    try { R.criarProvedoresDeRecuperacaoOffline({ chaves: { ...chaves(), mac: [{ chaveId: 'mac-hml-v1', estado: 'ATIVA', pacotes: [dMac.pacotes[0]] }] } }); } catch (e) {
      const texto = `${e.message} ${e.code} ${e.motivo} ${JSON.stringify(e)}`;
      for (const m of material) assert.equal(texto.includes(m), false);
    }
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'backup-fontes-recuperacao-offline.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:\\'"`])\/\/[^\n]*/g, '$1');
    assert.equal(/require\(['"]node:(?:fs|net|http|https|child_process|dns|tls)|process\.(?:env|stdin|argv)|@aws-sdk/.test(fonte), false);
  });
});

describe('[OFF-P] compatibilidade com a composição existente (P6, P11)', () => {
  test('OFF-25 — contêiner cifrado com as chaves originais é decifrado e verificado com as chaves RECONSTRUÍDAS das partes; o provedor encaixa nas fontes e em capturarChaves', async () => {
    const raiz = novaRaiz();
    const fonteMacOriginal = H.criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'mac-hml-v1', segredo: SEG_MAC }] });
    const fonteCifraOriginal = E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'kek-hml-v1', segredo: SEG_KEK }] });
    const p = pacoteSintetico(raiz, { fonteMac: fonteMacOriginal, macId: 'mac-hml-v1' });
    const container = path.join(raiz, 'container');
    const c = await E.cifrarPacote({ pacote: p.dir, lido: p.lido, destino: container, cifra: { fonte: fonteCifraOriginal, chaveId: 'kek-hml-v1' }, mac: { fonte: fonteMacOriginal, chaveId: 'mac-hml-v1' } });
    assert.equal(c.ok, true, JSON.stringify(c.falha));

    const off = R.criarProvedoresDeRecuperacaoOffline({ chaves: chaves(1, 2) });
    const fonteMac = H.criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: off.mac });
    const fonteCifra = E.criarFonteDeChavesDeCifra({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'kek-hml-v1', segredo: off.cifra.obter('kek-hml-v1').segredo }] });
    assert.equal(E.capturarChaves({ cifra: { fonte: fonteCifra, chaveId: 'kek-hml-v1' }, mac: { fonte: fonteMac, chaveId: 'mac-hml-v1' } }).motivo, undefined);
    const reconstruido = path.join(raiz, 'reconstruido');
    const d = await E.decifrarContainer({ container, destino: reconstruido, cifra: { fonte: fonteCifra, chaveId: 'kek-hml-v1' }, mac: { fonte: fonteMac, chaveId: 'mac-hml-v1' } });
    assert.equal(d.ok, true, JSON.stringify(d.falha));
    assert.deepEqual(arvore(reconstruido), arvore(p.dir));
    const leitor = Mm.criarLeitorL2({ fonteDeChaves: fonteMac, layoutMinimo: 2 });
    const bytes = fs.readFileSync(path.join(reconstruido, 'manifesto.json'));
    const lido = leitor({ bytes, sha256: sha(bytes) });
    assert.equal((await verificarPacoteL2({ pacote: reconstruido, lido })).ok, true);
  });

  test('OFF-26 — as fábricas operacionais e as listas de provedores continuam VAZIAS e BLOQUEADAS (o provedor off-line não é ativado)', () => {
    assert.equal(typeof R.PROVEDOR_ID, 'string');
    assert.deepEqual([...H.PROVEDORES_OPERACIONAIS_APROVADOS], []);
    assert.deepEqual([...E.PROVEDORES_DE_CIFRA_APROVADOS], []);
    const off = R.criarProvedoresDeRecuperacaoOffline({ chaves: chaves() });
    assert.throws(() => H.criarFonteOperacionalDeChaves({ provedor: R.PROVEDOR_ID, adaptador: off.mac }));
    assert.throws(() => E.criarFonteOperacionalDeCifra({ provedor: R.PROVEDOR_ID, adaptador: off.cifra }), (e) => e.code === 'FONTE_OPERACIONAL_INDISPONIVEL');
  });
});
