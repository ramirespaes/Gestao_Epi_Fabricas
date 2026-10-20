'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const a = require('../helpers/limpeza-orfaos');
const J = require('../../src/utils/janela-escrita-imagens');

/**
 * Trava de janela de escrita (P-ORF-01, G5): PROVA DE POSSE PELO TOKEN. A G1 devolvia `{ tipo, liberar }`; a G5 acrescenta `confirmarPosse(): Promise<{ confirmada }>`, que
 * compara o TOKEN da aquisição com o do arquivo sem nunca expô-lo (o token é a prova de posse: nem o resultado, nem as chaves, nem os valores do manipulador o levam). É uma
 * extensão aditiva: nenhum dos JAN-01 a 24 muda. Quem só tem tipo, PID e instante iguais NÃO tem a posse. Diretórios temporários distintos para o armazenamento e a trava.
 */

const { AGORA } = a;
const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };

function cenario() {
  const raiz = novaRaiz();
  const pastaDaTrava = novaRaiz();
  return { raiz, pastaDaTrava, arquivo: path.join(pastaDaTrava, 'janela-imagens.lock') };
}
const adquirir = (c, extra = {}) => J.adquirirJanela({ arquivo: c.arquivo, tipo: 'LIMPEZA', raizArmazenamento: c.raiz, agora: () => AGORA, ...extra });
const lerDoc = (arquivo) => JSON.parse(fs.readFileSync(arquivo, 'utf8'));
const exigirInterface = (janela) => assert.equal(typeof janela.confirmarPosse, 'function', 'contrato futuro: o manipulador ainda não tem confirmarPosse()');

describe('[JAN] confirmarPosse: a posse é do TOKEN', () => {
  test('JAN-25 — o manipulador ganha confirmarPosse(): { confirmada: true } para o dono, SEM tocar no arquivo e sem expor o token (nem no resultado, nem nas chaves, nem nos valores do manipulador)', async () => {
    const c = cenario();
    const janela = await adquirir(c);
    exigirInterface(janela);
    const antes = fs.readFileSync(c.arquivo);
    const { token } = lerDoc(c.arquivo);
    assert.deepEqual(Object.keys(janela).sort(), ['confirmarPosse', 'liberar', 'tipo']);
    assert.equal(Object.isFrozen(janela), true);
    const resposta = await janela.confirmarPosse();
    assert.deepEqual(resposta, { confirmada: true });
    assert.equal(JSON.stringify(resposta).includes(token), false);
    for (const valor of Object.values(janela)) assert.notEqual(valor, token);
    assert.deepEqual(fs.readFileSync(c.arquivo), antes, 'conferir não altera a trava');
    assert.deepEqual(await janela.confirmarPosse(), { confirmada: true }, 'pode ser conferida quantas vezes for preciso');
    assert.deepEqual(await janela.liberar(), { liberada: true });
  });

  test('JAN-26 — outra trava com o MESMO tipo, PID, hospedeiro e instante, mas TOKEN diferente, NÃO é do dono: confirmada falso, e liberar também recusa e deixa a trava alheia intacta', async () => {
    const c = cenario();
    const janela = await adquirir(c);
    exigirInterface(janela);
    const original = lerDoc(c.arquivo);
    const alheio = { ...original, token: crypto.randomBytes(16).toString('hex') };
    assert.notEqual(alheio.token, original.token);
    fs.writeFileSync(c.arquivo, `${JSON.stringify(alheio)}\n`);
    assert.deepEqual(await janela.confirmarPosse(), { confirmada: false });
    assert.deepEqual(await janela.liberar(), { liberada: false });
    assert.deepEqual(lerDoc(c.arquivo), alheio, 'a trava alheia continua como estava');
  });

  test('JAN-27 — trava ausente, ilegível, fora do protocolo, link simbólico (mesmo para um documento com o token certo) ou sem permissão de leitura: confirmada falso, sem erro e sem alterar nada', async () => {
    const casos = {
      ausente: (c) => { fs.rmSync(c.arquivo); },
      'texto qualquer': (c) => { fs.writeFileSync(c.arquivo, 'lixo'); },
      'JSON fora do protocolo': (c) => { fs.writeFileSync(c.arquivo, '{"tipo":"LIMPEZA"}\n'); },
      'link simbólico para um documento com o token certo': (c) => {
        const destino = path.join(c.pastaDaTrava, 'documento-com-o-token-certo.json');
        fs.writeFileSync(destino, `${JSON.stringify(lerDoc(c.arquivo))}\n`);
        fs.rmSync(c.arquivo);
        fs.symlinkSync(destino, c.arquivo);
      },
    };
    if (process.getuid?.() !== 0) casos['sem permissão de leitura'] = (c) => { fs.chmodSync(c.arquivo, 0o000); };
    for (const [rotulo, preparar] of Object.entries(casos)) {
      const c = cenario();
      const janela = await adquirir(c);
      exigirInterface(janela);
      preparar(c);
      const listagemAntes = fs.readdirSync(c.pastaDaTrava).sort();
      assert.deepEqual(await janela.confirmarPosse(), { confirmada: false }, rotulo);
      assert.deepEqual(fs.readdirSync(c.pastaDaTrava).sort(), listagemAntes, `${rotulo}: nada foi criado nem apagado`);
    }
  });

  test('JAN-28 — depois de liberar a posse acaba (mesmo que outro dono assuma a trava), e a posse de um dono novo nunca é do antigo, nem quando o arquivo foi apagado e recriado sem liberar', async () => {
    const c = cenario();
    const antigo = await adquirir(c);
    exigirInterface(antigo);
    assert.deepEqual(await antigo.liberar(), { liberada: true });
    assert.deepEqual(await antigo.confirmarPosse(), { confirmada: false }, 'liberada: não é mais dele');
    const novo = await adquirir(c, { tipo: 'BACKUP' });
    assert.deepEqual(await antigo.confirmarPosse(), { confirmada: false });
    assert.deepEqual(await novo.confirmarPosse(), { confirmada: true });
    assert.deepEqual(await novo.liberar(), { liberada: true });

    const d = cenario();
    const primeiro = await adquirir(d);
    fs.rmSync(d.arquivo);
    const segundo = await adquirir(d, { tipo: 'BACKUP' });
    assert.deepEqual(await primeiro.confirmarPosse(), { confirmada: false }, 'apagada e recriada por outro: o token mudou');
    assert.deepEqual(await segundo.confirmarPosse(), { confirmada: true });
    await segundo.liberar();
  });
});
