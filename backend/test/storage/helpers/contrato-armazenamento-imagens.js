'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { PassThrough } = require('node:stream');

/**
 * SUÍTE DE CONTRATO do armazenamento de imagens (Biblioteca de Imagens, Unidade 1; contratos ARM-01 a ARM-13 do doc. 14).
 * Independe de disco: roda contra qualquer driver que cumpra a interface (local agora, o falso em memória como calibração,
 * S3 depois). Cada driver entrega `criar()` -> Promise<{ armazenamento, limpar }>.
 *
 * Interface contratada (todas as operações devolvem Promise; chave inválida REJEITA a Promise, nunca lança de forma síncrona):
 *   gravar(chave, fonte (Buffer ou Readable), { maxBytes (obrigatório), sha256Esperado?, signal? })
 *       -> { chave, bytes, sha256, reaproveitado }   (nenhum caminho do sistema de arquivos no resultado)
 *   abrir(chave) -> Readable            existe(chave) -> boolean            remover(chave) -> void
 *   removerVariantes({ escopo: 'EMPRESA'|'PADRAO', empresaId?, sha256 }) -> void
 *   listar(prefixo ('<empresaId>' ou 'padrao')) -> string[] (chaves válidas, ordenadas)
 * Códigos de erro (propriedade `codigo`): CHAVE_INVALIDA, CHAVE_COM_CONTEUDO_DIFERENTE, ARQUIVO_AUSENTE, LIMITE_BYTES_EXCEDIDO,
 * LIMITE_OBRIGATORIO, INTEGRIDADE_DIVERGENTE, GRAVACAO_ABORTADA. As mensagens NUNCA levam a chave, o caminho nem o conteúdo.
 */

const MAX = 1 << 20;
const esperar = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
const sha256De = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const bytesAleatorios = (n = 2048) => crypto.randomBytes(n);

async function lerStream(stream) {
  const partes = [];
  for await (const parte of stream) partes.push(Buffer.from(parte));
  return Buffer.concat(partes);
}

/** ORÁCULO do formato da chave: `<empresaId|padrao>/<sha256>/<variante>.<ext>`. Escrito só com o texto do contrato. */
function chaveOraculo({ empresaId, sha, variante = 'mestre', ext = variante === 'mestre' ? 'png' : 'webp' }) {
  return `${empresaId}/${sha}/${variante}.${ext}`;
}

const H = 'a'.repeat(64);
const CHAVES_HOSTIS = [
  '', ' ', '../x', '/etc/passwd', `../1/${H}/mestre.png`, `1/../2/${H}/mestre.png`, `1/${H}/../mestre.png`,
  `1\\${H}\\mestre.png`, `1/${H}/mestre.png\0`, `%2e%2e/1/${H}/mestre.png`, `0/${H}/mestre.png`, `01/${H}/mestre.png`,
  `-1/${H}/mestre.png`, `1.5/${H}/mestre.png`, `PADRAO/${H}/mestre.png`, `padrao2/${H}/mestre.png`, `padrao/padrao/${H}/mestre.png`,
  `1/${'A'.repeat(64)}/mestre.png`, `1/${'a'.repeat(63)}/mestre.png`, `1/${'a'.repeat(65)}/mestre.png`, `1/${H}/mestre.gif`,
  `1/${H}/MESTRE.png`, `1/${H}/original.png`, `1/${H}/miniatura.png`, `1/${H}/exibicao.jpg`, `1/${H}/mestre.png/`, `1//${H}/mestre.png`,
  ` 1/${H}/mestre.png`, `1/${H}/mestre.png `, `1/${H}/mestre.png/extra`, `9999999999999999/${H}/mestre.png`,
  '../SEGREDO-NO-CAMINHO', null, undefined, 123, {}, [`1/${H}/mestre.png`],
];
const PREFIXOS_HOSTIS = ['', ' ', '../', '..', '1/..', '1/', '/1', 'padrao/x', 'PADRAO', '01', '0', '-1', '1.5', `1/${H}`, 'todos', '*', null, undefined, 1];

const CODIGO_INVALIDA = 'CHAVE_INVALIDA';

/** Exige que a operação devolva uma Promise e que ela REJEITE com o código dado (nunca lançar de forma síncrona). */
async function rejeitaComCodigo(chamar, codigo, rotulo) {
  let promessa;
  try { promessa = chamar(); } catch (falha) { assert.fail(`${rotulo}: lançou de forma síncrona (${falha && falha.message})`); }
  assert.equal(typeof (promessa && promessa.then), 'function', `${rotulo}: não devolveu Promise`);
  await assert.rejects(promessa, (falha) => {
    assert.equal(falha.codigo, codigo, `${rotulo}: código ${falha.codigo}`);
    return true;
  }, rotulo);
}

function rodarContrato({ nome, criar }) {
  const com = (corpo) => async () => {
    const contexto = await criar();
    try { await corpo(contexto.armazenamento, contexto); } finally { await contexto.limpar(); }
  };

  describe(`contrato do armazenamento de imagens — ${nome}`, () => {
    test('[ARM-01] a interface expõe gravar, abrir, existe, remover, removerVariantes e listar; tudo é assíncrono e sem caminho do disco no resultado', com(async (a) => {
      for (const m of ['gravar', 'abrir', 'existe', 'remover', 'removerVariantes', 'listar']) assert.equal(typeof a[m], 'function', m);
      const bytes = bytesAleatorios();
      const sha = sha256De(bytes);
      const chave = chaveOraculo({ empresaId: 1, sha });
      const promessa = a.gravar(chave, bytes, { maxBytes: MAX });
      assert.equal(typeof promessa.then, 'function');
      const resultado = await promessa;
      assert.deepEqual(Object.keys(resultado).sort(), ['bytes', 'chave', 'reaproveitado', 'sha256'], 'o resultado só traz chave, bytes, sha256 e reaproveitado');
      assert.deepEqual([resultado.chave, resultado.bytes, resultado.sha256, resultado.reaproveitado], [chave, bytes.length, sha, false]);
      const aberto = await a.abrir(chave);
      assert.ok(typeof aberto.pipe === 'function' || typeof aberto[Symbol.asyncIterator] === 'function', 'abrir devolve um stream legível');
      assert.equal(await a.existe(chave), true);
      assert.equal(typeof (await a.existe(chaveOraculo({ empresaId: 1, sha: 'b'.repeat(64) }))), 'boolean');
    }));

    test('[ARM-03] chave maliciosa ou fora do formato é recusada em TODAS as operações, de forma assíncrona e sem ecoar a chave', com(async (a) => {
      assert.ok(CHAVES_HOSTIS.length >= 30);
      for (const chave of CHAVES_HOSTIS) {
        const rotulo = JSON.stringify(chave === undefined ? 'undefined' : chave);
        await rejeitaComCodigo(() => a.gravar(chave, Buffer.from('x'), { maxBytes: 100 }), CODIGO_INVALIDA, `gravar ${rotulo}`);
        await rejeitaComCodigo(() => a.abrir(chave), CODIGO_INVALIDA, `abrir ${rotulo}`);
        await rejeitaComCodigo(() => a.existe(chave), CODIGO_INVALIDA, `existe ${rotulo}`);
        await rejeitaComCodigo(() => a.remover(chave), CODIGO_INVALIDA, `remover ${rotulo}`);
      }
      for (const prefixo of PREFIXOS_HOSTIS) await rejeitaComCodigo(() => a.listar(prefixo), CODIGO_INVALIDA, `listar ${JSON.stringify(prefixo)}`);
      await assert.rejects(a.abrir('../SEGREDO-NO-CAMINHO'), (falha) => { assert.doesNotMatch(falha.message, /SEGREDO/); return true; });
      assert.deepEqual(await a.listar('1'), [], 'nada foi gravado pelas tentativas hostis');
    }));

    test('[ARM-04] a gravação é atômica: durante a escrita a chave definitiva não existe; ao fim, bytes e SHA-256 corretos e leitura idêntica byte a byte', com(async (a) => {
      const bytes = bytesAleatorios(5000);
      const chave = chaveOraculo({ empresaId: 5, sha: sha256De(bytes) });
      const fonte = new PassThrough();
      const promessa = a.gravar(chave, fonte, { maxBytes: MAX });
      fonte.write(bytes.subarray(0, 1000));
      await esperar(60);
      assert.equal(await a.existe(chave), false, 'metade escrita não pode aparecer na chave definitiva');
      fonte.end(bytes.subarray(1000));
      const resultado = await promessa;
      assert.deepEqual([resultado.bytes, resultado.sha256, resultado.reaproveitado], [5000, sha256De(bytes), false]);
      assert.equal(await a.existe(chave), true);
      assert.ok((await lerStream(await a.abrir(chave))).equals(bytes), 'leitura idêntica byte a byte');
    }));

    test('[ARM-04b] integridade por SHA-256: com o SHA-256 esperado correto grava; com o errado recusa (INTEGRIDADE_DIVERGENTE) e não publica nada', com(async (a) => {
      const bytes = bytesAleatorios();
      const sha = sha256De(bytes);
      const chave = chaveOraculo({ empresaId: 2, sha, variante: 'miniatura' });
      await rejeitaComCodigo(() => a.gravar(chave, bytes, { maxBytes: MAX, sha256Esperado: 'f'.repeat(64) }), 'INTEGRIDADE_DIVERGENTE', 'sha errado');
      assert.equal(await a.existe(chave), false);
      assert.deepEqual(await a.listar('2'), []);
      const ok = await a.gravar(chave, bytes, { maxBytes: MAX, sha256Esperado: sha });
      assert.equal(ok.sha256, sha);
      assert.equal(await a.existe(chave), true);
    }));

    test('[ARM-05] idempotência: os mesmos bytes duas vezes são reaproveitados; bytes DIFERENTES na mesma chave são recusados e o original fica intacto', com(async (a) => {
      const original = bytesAleatorios();
      const chave = chaveOraculo({ empresaId: 3, sha: sha256De(original) });
      const primeira = await a.gravar(chave, original, { maxBytes: MAX });
      const segunda = await a.gravar(chave, Buffer.from(original), { maxBytes: MAX });
      assert.deepEqual([primeira.reaproveitado, segunda.reaproveitado], [false, true]);
      assert.deepEqual([segunda.bytes, segunda.sha256], [original.length, sha256De(original)]);
      await rejeitaComCodigo(() => a.gravar(chave, bytesAleatorios(), { maxBytes: MAX }), 'CHAVE_COM_CONTEUDO_DIFERENTE', 'bytes diferentes');
      assert.ok((await lerStream(await a.abrir(chave))).equals(original), 'o original permanece intacto');
      assert.deepEqual(await a.listar('3'), [chave], 'nenhum resíduo da tentativa recusada');
    }));

    test('[ARM-06] isolamento: a mesma chave de conteúdo em empresas diferentes e na biblioteca padrão são arquivos distintos; remover um não toca nos outros', com(async (a) => {
      const sha = sha256De(Buffer.from('conteudo-de-referencia'));
      const [b1, b2, bp] = [Buffer.from('empresa-1'), Buffer.from('empresa-2'), Buffer.from('padrao')];
      const [k1, k2, kp] = [chaveOraculo({ empresaId: 1, sha }), chaveOraculo({ empresaId: 2, sha }), chaveOraculo({ empresaId: 'padrao', sha })];
      for (const [k, b] of [[k1, b1], [k2, b2], [kp, bp]]) await a.gravar(k, b, { maxBytes: MAX });
      assert.ok((await lerStream(await a.abrir(k1))).equals(b1));
      assert.ok((await lerStream(await a.abrir(k2))).equals(b2));
      assert.ok((await lerStream(await a.abrir(kp))).equals(bp));
      assert.deepEqual(await a.listar('1'), [k1]);
      assert.deepEqual(await a.listar('2'), [k2]);
      assert.deepEqual(await a.listar('padrao'), [kp]);
      await a.remover(k1);
      assert.deepEqual([await a.existe(k1), await a.existe(k2), await a.existe(kp)], [false, true, true]);
    }));

    test('[ARM-06b] removerVariantes apaga as três variantes de UMA imagem de UMA empresa (ou da padrão) e nada além; argumentos inválidos são recusados', com(async (a) => {
      const x = sha256De(Buffer.from('x'));
      const y = sha256De(Buffer.from('y'));
      const grava = (empresaId, sha) => Promise.all([
        a.gravar(chaveOraculo({ empresaId, sha, variante: 'mestre' }), Buffer.from(`m${empresaId}${sha}`), { maxBytes: MAX }),
        a.gravar(chaveOraculo({ empresaId, sha, variante: 'exibicao' }), Buffer.from(`e${empresaId}${sha}`), { maxBytes: MAX }),
        a.gravar(chaveOraculo({ empresaId, sha, variante: 'miniatura' }), Buffer.from(`n${empresaId}${sha}`), { maxBytes: MAX }),
      ]);
      await grava(1, x); await grava(2, x); await grava(1, y); await grava('padrao', x);
      assert.equal((await a.listar('1')).length, 6);
      await a.removerVariantes({ escopo: 'EMPRESA', empresaId: 1, sha256: x });
      const restantes1 = await a.listar('1');
      assert.equal(restantes1.length, 3);
      assert.ok(restantes1.every((k) => k.includes(`/${y}/`)));
      assert.equal((await a.listar('2')).length, 3, 'outra empresa intacta');
      assert.equal((await a.listar('padrao')).length, 3, 'biblioteca padrão intacta');
      await a.removerVariantes({ escopo: 'PADRAO', sha256: x });
      assert.equal((await a.listar('padrao')).length, 0);
      assert.equal((await a.listar('2')).length, 3);
      const invalidos = [
        { escopo: 'EMPRESA', empresaId: 0, sha256: x }, { escopo: 'EMPRESA', empresaId: -1, sha256: x }, { escopo: 'EMPRESA', empresaId: 1.5, sha256: x },
        { escopo: 'EMPRESA', empresaId: '1', sha256: x }, { escopo: 'EMPRESA', sha256: x }, { escopo: 'PADRAO', empresaId: 1, sha256: x },
        { escopo: 'EMPRESA', empresaId: 1, sha256: x.toUpperCase() }, { escopo: 'EMPRESA', empresaId: 1, sha256: 'curto' },
        { escopo: 'EMPRESA', empresaId: 1, sha256: `${x}/..` }, { escopo: 'OUTRO', empresaId: 1, sha256: x }, {}, undefined,
      ];
      for (const argumentos of invalidos) await rejeitaComCodigo(() => a.removerVariantes(argumentos), CODIGO_INVALIDA, `removerVariantes ${JSON.stringify(argumentos)}`);
      assert.equal((await a.listar('1')).length, 3, 'as tentativas inválidas não apagaram nada');
    }));

    test('[ARM-08] falha ou aborto no meio da gravação não publica nada e não destrói o arquivo que já existia', com(async (a) => {
      const bytes = bytesAleatorios();
      const chave = chaveOraculo({ empresaId: 7, sha: sha256De(bytes) });
      // 1) erro do stream no meio
      const fonte = new PassThrough();
      const promessa = a.gravar(chave, fonte, { maxBytes: MAX });
      fonte.write(bytes.subarray(0, 100));
      fonte.destroy(new Error('queda simulada'));
      await assert.rejects(promessa);
      assert.equal(await a.existe(chave), false);
      assert.deepEqual(await a.listar('7'), []);
      // 2) aborto pelo sinal
      const controle = new AbortController();
      const fonte2 = new PassThrough();
      const promessa2 = a.gravar(chave, fonte2, { maxBytes: MAX, signal: controle.signal });
      fonte2.write(bytes.subarray(0, 100));
      await esperar(30);
      controle.abort();
      await assert.rejects(promessa2, (falha) => { assert.equal(falha.codigo, 'GRAVACAO_ABORTADA'); return true; });
      fonte2.destroy();
      assert.equal(await a.existe(chave), false);
      assert.deepEqual(await a.listar('7'), []);
      // 3) sinal já abortado antes de começar
      const jaAbortado = new AbortController();
      jaAbortado.abort();
      await rejeitaComCodigo(() => a.gravar(chave, Buffer.from('x'), { maxBytes: MAX, signal: jaAbortado.signal }), 'GRAVACAO_ABORTADA', 'sinal já abortado');
      assert.equal(await a.existe(chave), false);
      // 4) o arquivo que já existia sobrevive a uma regravação que falha
      await a.gravar(chave, bytes, { maxBytes: MAX });
      const fonte3 = new PassThrough();
      const promessa3 = a.gravar(chave, fonte3, { maxBytes: MAX });
      fonte3.write(Buffer.from('conteudo-parcial-diferente'));
      fonte3.destroy(new Error('queda simulada 2'));
      await assert.rejects(promessa3);
      assert.ok((await lerStream(await a.abrir(chave))).equals(bytes), 'o original continua intacto');
      assert.deepEqual(await a.listar('7'), [chave]);
    }));

    test('[ARM-09] limite de bytes: o limite é obrigatório; o excesso (em Buffer ou em stream) é recusado sem resíduo; o valor exato passa', com(async (a) => {
      const chave = chaveOraculo({ empresaId: 8, sha: sha256De(Buffer.from('l')) });
      await rejeitaComCodigo(() => a.gravar(chave, Buffer.alloc(10), {}), 'LIMITE_OBRIGATORIO', 'sem limite');
      await rejeitaComCodigo(() => a.gravar(chave, Buffer.alloc(10), { maxBytes: 0 }), 'LIMITE_OBRIGATORIO', 'limite zero');
      await rejeitaComCodigo(() => a.gravar(chave, Buffer.alloc(10), { maxBytes: -5 }), 'LIMITE_OBRIGATORIO', 'limite negativo');
      await rejeitaComCodigo(() => a.gravar(chave, Buffer.alloc(10), { maxBytes: 1.5 }), 'LIMITE_OBRIGATORIO', 'limite decimal');
      await rejeitaComCodigo(() => a.gravar(chave, Buffer.alloc(101), { maxBytes: 100 }), 'LIMITE_BYTES_EXCEDIDO', 'Buffer acima');
      const fonte = new PassThrough();
      const promessa = a.gravar(chave, fonte, { maxBytes: 100 });
      fonte.write(Buffer.alloc(60));
      fonte.write(Buffer.alloc(60));
      await assert.rejects(promessa, (falha) => { assert.equal(falha.codigo, 'LIMITE_BYTES_EXCEDIDO'); return true; });
      fonte.destroy();
      assert.equal(await a.existe(chave), false);
      assert.deepEqual(await a.listar('8'), []);
      const exato = await a.gravar(chave, Buffer.alloc(100, 7), { maxBytes: 100 });
      assert.equal(exato.bytes, 100);
    }));

    test('[ARM-10] listar devolve só as chaves válidas do prefixo, ordenadas; empresa sem arquivos devolve lista vazia', com(async (a) => {
      const shas = [sha256De(Buffer.from('1')), sha256De(Buffer.from('2'))].sort();
      const esperadas = [
        chaveOraculo({ empresaId: 4, sha: shas[0], variante: 'mestre' }), chaveOraculo({ empresaId: 4, sha: shas[0], variante: 'miniatura' }),
        chaveOraculo({ empresaId: 4, sha: shas[1], variante: 'mestre', ext: 'jpg' }),
      ].sort();
      for (const chave of esperadas) await a.gravar(chave, Buffer.from(chave), { maxBytes: MAX });
      await a.gravar(chaveOraculo({ empresaId: 40, sha: shas[0] }), Buffer.from('outra'), { maxBytes: MAX });
      assert.deepEqual(await a.listar('4'), esperadas, 'a empresa 4 não enxerga a 40 (prefixo é por segmento inteiro)');
      assert.deepEqual(await a.listar('999'), []);
      assert.deepEqual(await a.listar('padrao'), []);
    }));

    test('[ARM-11] arquivo ausente: ARQUIVO_AUSENTE, sem a chave nem o caminho na mensagem', com(async (a) => {
      const sha = sha256De(Buffer.from('ausente-SEGREDO'));
      const chave = chaveOraculo({ empresaId: 6, sha });
      await assert.rejects(a.abrir(chave), (falha) => {
        assert.equal(falha.codigo, 'ARQUIVO_AUSENTE');
        assert.ok(!falha.message.includes(sha), 'a mensagem não leva o hash');
        assert.ok(!falha.message.includes('/'), 'a mensagem não leva caminho');
        return true;
      });
      assert.equal(await a.existe(chave), false);
      await a.remover(chave); // remover o que não existe é idempotente
    }));

    test('[ARM-12] concorrência: 20 gravações iguais em paralelo resultam em UM arquivo íntegro (uma nova e 19 reaproveitadas); duas diferentes: só uma vence', com(async (a) => {
      const bytes = bytesAleatorios(4096);
      const chave = chaveOraculo({ empresaId: 9, sha: sha256De(bytes) });
      const resultados = await Promise.all(Array.from({ length: 20 }, () => a.gravar(chave, Buffer.from(bytes), { maxBytes: MAX })));
      assert.equal(resultados.filter((r) => r.reaproveitado === false).length, 1);
      assert.equal(resultados.filter((r) => r.reaproveitado === true).length, 19);
      assert.ok((await lerStream(await a.abrir(chave))).equals(bytes));
      assert.deepEqual(await a.listar('9'), [chave]);

      const [x, y] = [bytesAleatorios(4096), bytesAleatorios(4096)];
      const chave2 = chaveOraculo({ empresaId: 10, sha: sha256De(x) });
      const disputa = await Promise.allSettled([a.gravar(chave2, x, { maxBytes: MAX }), a.gravar(chave2, y, { maxBytes: MAX })]);
      assert.equal(disputa.filter((r) => r.status === 'fulfilled').length, 1, 'só uma vence');
      const perdedora = disputa.find((r) => r.status === 'rejected');
      assert.equal(perdedora.reason.codigo, 'CHAVE_COM_CONTEUDO_DIFERENTE');
      const vencedor = disputa[0].status === 'fulfilled' ? x : y;
      assert.ok((await lerStream(await a.abrir(chave2))).equals(vencedor), 'o conteúdo publicado é inteiro de um dos dois, nunca misturado');
      assert.deepEqual(await a.listar('10'), [chave2]);
    }));
  });
}

module.exports = {
  rodarContrato, chaveOraculo, sha256De, bytesAleatorios, lerStream, esperar, rejeitaComCodigo, CHAVES_HOSTIS, PREFIXOS_HOSTIS, H, MAX,
};
