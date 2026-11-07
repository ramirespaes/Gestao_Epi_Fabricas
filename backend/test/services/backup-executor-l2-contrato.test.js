'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { criarLeitorDePacote } = require('../../src/services/backup-executor-leitor-pacote.service');
const { ehResultadoDoLeitor } = require('../../src/services/backup-fontes-manifesto-l2.service');
const { verificarPacoteL2 } = require('../../src/services/backup-fontes-composicao-l2.service');
const { cifrarPacote } = require('../../src/services/backup-fontes-cifra-envelope.service');
const { prepararAmbiente } = require('../helpers/ambiente-executor');
const { limparRaizes } = require('../helpers/pacote-l2-sintetico');

/**
 * D-ORF-6, L2 (Bloco C) [L7]: CONTRATO entre o `lido` que a porta `producao` entrega (leitor REAL sobre o pacote publicado) e o que a publicação exige (`verificarPacoteL2` e `cifrarPacote`,
 * chamados por `publicarPacoteDuravel`). Risco L7 do PREP-01: divergência entre o `lido` do L2 e o esperado pela publicação. Pacote sintético escrito pelo escritor L2 real.
 */

after(limparRaizes);
const OP = 'a1'.repeat(16);

describe('[L7] lido do leitor real × publicação', () => {
  test('L7-01 — o `lido` do leitor real é reconhecido pelo núcleo L2 e aceito por verificarPacoteL2 (árvore exata) e por cifrarPacote (cifra em envelope) sem qualquer adaptação', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-l7a' });
    const lido = await criarLeitorDePacote({ fonteDeChaves: x.fonteMac, raizPublicados: x.raiz }).lerPacote({ dir: x.pacote.dir, nome: 'pacote' });
    assert.ok(ehResultadoDoLeitor(lido));
    const v = await verificarPacoteL2({ pacote: x.pacote.dir, lido });
    assert.deepEqual({ ...v }, { ok: true, arquivos: 5, sha256Manifesto: x.pacote.lido.sha256, layout: 2 });
    const destino = path.join(x.raiz, 'container-l7');
    const c = await cifrarPacote({ pacote: x.pacote.dir, lido, destino, cifra: x.chaves.cifra, mac: x.chaves.mac });
    assert.equal(c.ok, true, JSON.stringify(c));
    assert.ok(fs.existsSync(path.join(destino, 'dados')));
  });

  test('L7-02 — forma do pedido do adaptador de produção: `Object.freeze({ dir: <raiz>/<l2-operacaoId>, nome })`, e o `lido` devolvido tem `identidade.sha256Manifesto` no formato que o adaptador exige', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-l7b' });
    const nome = `l2-${OP}`;
    const dir = path.join(x.raiz, nome);
    fs.renameSync(x.pacote.dir, dir);
    const lido = await criarLeitorDePacote({ fonteDeChaves: x.fonteMac, raizPublicados: x.raiz }).lerPacote(Object.freeze({ dir, nome }));
    assert.match(lido.identidade.sha256Manifesto, /^[0-9a-f]{64}$/);
    assert.equal(lido.identidade.sha256Manifesto, x.pacote.lido.sha256);
    assert.equal((await verificarPacoteL2({ pacote: dir, lido })).ok, true);
  });

  test('L7-03 — um `lido` COPIADO (mesmos campos, outro objeto) não é reconhecido pelo núcleo L2: só o leitor produz o que a restauração e a cifra aceitam como autenticado', async () => {
    const x = await prepararAmbiente({ conjuntoId: 'conjunto-l7c' });
    const lido = await criarLeitorDePacote({ fonteDeChaves: x.fonteMac, raizPublicados: x.raiz }).lerPacote({ dir: x.pacote.dir, nome: 'pacote' });
    const copia = { ...lido, identidade: { ...lido.identidade }, caminhoDe: lido.caminhoDe };
    assert.equal(ehResultadoDoLeitor(copia), false);
    assert.equal(ehResultadoDoLeitor(lido), true);
  });
});
