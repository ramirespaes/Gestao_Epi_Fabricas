'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const S = require('../../src/services/imagem-armazenamento-limpeza.service');
const a = require('../helpers/limpeza-orfaos');

/**
 * LIMPEZA DE ÓRFÃOS (Biblioteca de Imagens, P-ORF-01, G5): PROTEÇÕES DA EXECUÇÃO além dos 33 testes da G4. Nasceram como verificações extras da G4 (X-01 a X-06, X-10 e
 * X-20), promovidas a testes na abertura da G5 por decisão de Ramires, e ganharam a prova de posse da trava pelo TOKEN (EXE-09). Cada teste afirma um EFEITO (o que ficou
 * no disco, o que o relatório diz, o que o erro carrega), nunca só a ausência de uma operação. Diretórios temporários, banco falso e dados fictícios.
 */

const { AGORA, DIA, h } = a;
const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };
const mundo = (opcoes) => a.criarMundo(novaRaiz, opcoes);
const erroDe = (promessa) => promessa.then(() => null, (erro) => erro);
const comJanela = (m) => ({ janela: { arquivo: m.arquivoDaJanela } });
const executar = (m, extra = {}) => S.limparOrfaos(m.banco, {
  diretorio: m.raiz, fs: m.fs, agora: () => AGORA, executar: true, intervaloBackupMinutos: 60, ...comJanela(m), ...extra,
});
/** Troca o arquivo por OUTRO com o mesmo conteúdo, tamanho e data, mas inode novo (rename de um arquivo recém-criado por cima). */
const trocarPorOutroArquivo = (alvo) => {
  const temporario = `${alvo}.troca`;
  fs.writeFileSync(temporario, fs.readFileSync(alvo));
  a.envelhecer(temporario, 3 * DIA);
  fs.renameSync(temporario, alvo);
};

describe('[EXE] a posse da trava de janela é conferida antes de apagar, e perdê-la nunca vira sucesso', () => {
  test('EXE-01 — a trava é TROCADA por um backup depois da reconferência e antes de apagar: nada é apagado, o erro é JANELA_PERDIDA, a trava do backup fica byte a byte igual e o relatório parcial diz PERDIDA', async () => {
    const m = mundo({ orfaos: [{ semente: 'exe1', idadeMin: 3 * DIA }] });
    let escrito;
    const erro = await erroDe(executar(m, { ganchos: { antesDeRemover: async () => {
      fs.rmSync(m.arquivoDaJanela);
      a.escreverTravaAlheia(m.arquivoDaJanela, { tipo: 'BACKUP', pid: 4242 });
      escrito = fs.readFileSync(m.arquivoDaJanela);
    } } }));
    assert.ok(erro instanceof S.ErroDeLimpeza);
    assert.equal(erro.codigo, 'JANELA_PERDIDA');
    assert.deepEqual(m.destrutivas(), []);
    assert.equal(m.orfaos[0].existe(), true);
    assert.deepEqual(fs.readFileSync(m.arquivoDaJanela), escrito, 'a trava do backup não foi tocada');
    assert.equal(erro.relatorioParcial.janela.estado, 'PERDIDA');
    assert.deepEqual(erro.relatorioParcial.removidos, []);
    assert.equal(m.banco.contadores.conexoes, m.banco.contadores.liberacoes);
  });

  test('EXE-02 — a trava é APAGADA por fora antes de apagar: JANELA_PERDIDA, nada apagado e a limpeza não recria a trava', async () => {
    const m = mundo({ orfaos: [{ semente: 'exe2', idadeMin: 3 * DIA }] });
    const erro = await erroDe(executar(m, { ganchos: { antesDeRemover: async () => { fs.rmSync(m.arquivoDaJanela); } } }));
    assert.equal(erro?.codigo, 'JANELA_PERDIDA');
    assert.deepEqual(m.destrutivas(), []);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
    assert.equal(m.orfaos[0].nomes().length, 3);
  });

  test('EXE-03 — a trava some DEPOIS da remoção (só percebida ao soltar): não vira sucesso; o erro leva o relatório com o que já foi removido e os bytes liberados', async () => {
    const m = mundo({ orfaos: [{ semente: 'exe3', idadeMin: 3 * DIA }] });
    const erro = await erroDe(executar(m, { ganchos: { aposRemover: async () => { fs.rmSync(m.arquivoDaJanela); } } }));
    assert.equal(erro?.codigo, 'JANELA_PERDIDA');
    assert.equal(erro.relatorioParcial.janela.estado, 'PERDIDA');
    assert.deepEqual(erro.relatorioParcial.removidos.map((x) => x.hash), [m.orfaos[0].hash]);
    assert.equal(erro.relatorioParcial.resumo.bytesLiberados, 540);
    assert.equal(m.orfaos[0].existe(), false, 'o trabalho já tinha sido feito: o erro só não deixa chamá-lo de sucesso');
  });

  test('EXE-09 — a trava é SUBSTITUÍDA por outra com o MESMO tipo, PID, hospedeiro e instante, mas TOKEN diferente: a posse é provada pelo token, então nada é apagado, a trava alheia fica intacta e o token nunca aparece no erro nem no relatório', async () => {
    const m = mundo({ orfaos: [{ semente: 'exe9', idadeMin: 3 * DIA }] });
    let original;
    let alheia;
    const erro = await erroDe(executar(m, { ganchos: { antesDeRemover: async () => {
      original = JSON.parse(fs.readFileSync(m.arquivoDaJanela, 'utf8'));
      const outroToken = crypto.randomBytes(16).toString('hex');
      assert.notEqual(outroToken, original.token);
      fs.writeFileSync(m.arquivoDaJanela, `${JSON.stringify({ ...original, token: outroToken })}\n`);
      alheia = fs.readFileSync(m.arquivoDaJanela);
      const depois = JSON.parse(alheia.toString('utf8'));
      assert.deepEqual({ ...depois, token: null }, { ...original, token: null }, 'precondição: só o token difere');
    } } }));
    assert.equal(erro?.codigo, 'JANELA_PERDIDA');
    assert.deepEqual(m.destrutivas(), [], 'contrato futuro: nada pode ser apagado sem a posse provada pelo token (só tipo, PID e instante não bastam)');
    assert.equal(m.orfaos[0].existe(), true);
    assert.deepEqual(fs.readFileSync(m.arquivoDaJanela), alheia, 'a trava alheia não foi removida nem alterada');
    assert.equal(erro.relatorioParcial.janela.estado, 'PERDIDA');
    assert.equal(`${erro.message}${JSON.stringify(erro.relatorioParcial)}`.includes(original.token), false, 'o token não aparece no erro nem no relatório');
  });
});

describe('[EXE] o arquivo conferido é o MESMO que é apagado', () => {
  test('EXE-04 — um arquivo é TROCADO por outro (mesmo tamanho e data, inode novo) depois da conferência e antes do primeiro unlink: nada é apagado e o erro identifica a mudança', async () => {
    const m = mundo({ orfaos: [{ semente: 'exe4', idadeMin: 3 * DIA }] });
    const alvo = m.orfaos[0].caminhos['exibicao.webp'];
    let antes;
    let depois;
    const erro = await erroDe(executar(m, { ganchos: { antesDeRemover: async () => {
      antes = fs.statSync(alvo);
      trocarPorOutroArquivo(alvo);
      depois = fs.statSync(alvo);
    } } }));
    assert.equal(antes.size, depois.size, 'precondição: mesmo tamanho');
    assert.equal(antes.mtimeMs, depois.mtimeMs, 'precondição: mesma data');
    assert.notEqual(antes.ino, depois.ino, 'precondição: arquivo diferente no disco');
    assert.equal(erro?.codigo, 'ARMAZENAMENTO_ALTERADO_DURANTE_A_REMOCAO');
    assert.deepEqual(m.destrutivas(), []);
    assert.deepEqual(erro.conjunto.arquivosJaRemovidos, []);
    assert.equal(m.orfaos[0].nomes().length, 3);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false, 'a trava foi solta');
  });

  test('EXE-05 — a mesma troca no SEGUNDO arquivo: o primeiro já saiu e isso é identificado (arquivosJaRemovidos e bytesLiberados do relatório parcial); o conjunto não é declarado removido e o arquivo trocado e o resto ficam', async () => {
    const m = mundo({ orfaos: [{ semente: 'exe5', idadeMin: 3 * DIA }] });
    const erro = await erroDe(executar(m, { ganchos: { antesDeRemover: async () => { trocarPorOutroArquivo(m.orfaos[0].caminhos['mestre.png']); } } }));
    assert.equal(erro?.codigo, 'ARMAZENAMENTO_ALTERADO_DURANTE_A_REMOCAO');
    assert.deepEqual(erro.conjunto.arquivosJaRemovidos.map((f) => [f.nome, f.bytes, f.sha256]), [['exibicao.webp', 120, h.sha(m.orfaos[0].conteudos['exibicao.webp'])]]);
    assert.equal(erro.relatorioParcial.resumo.bytesLiberados, 120);
    assert.deepEqual(erro.relatorioParcial.removidos, []);
    assert.deepEqual(m.orfaos[0].nomes(), ['mestre.png', 'miniatura.webp']);
  });
});

describe('[EXE] erros e relatório parcial', () => {
  test('EXE-06 — erro inesperado de E/S propaga o MESMO objeto com o código original (EIO), a trava é solta e o relatório parcial vai junto sem aparecer em JSON nem nas chaves do erro', async () => {
    const m = mundo({ orfaos: [{ semente: 'exe6', idadeMin: 3 * DIA }] });
    const injetado = Object.assign(new Error('falha de disco simulada'), { code: 'EIO' });
    const erro = await erroDe(executar(m, { ganchos: { antesDeRemover: async () => { throw injetado; } } }));
    assert.equal(erro, injetado);
    assert.equal(erro.code, 'EIO');
    assert.equal(erro.relatorioParcial.janela.estado, 'LIBERADA');
    assert.equal(erro.relatorioParcial.candidatos.length, 1);
    assert.equal(Object.keys(erro).includes('relatorioParcial'), false);
    assert.equal(JSON.stringify(erro).includes('relatorioParcial'), false);
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
    assert.equal(m.orfaos[0].existe(), true);
  });

  test('EXE-07 — unlink que acusa ENOENT (outro processo já apagou) não é falha: o arquivo não entra no relatório nem nos bytes liberados e a execução segue', async () => {
    const m = mundo({ orfaos: [{ semente: 'exe7', idadeMin: 3 * DIA }] });
    const sumiu = a.fachadaDeLimpeza(m.raiz, { eventos: m.eventos, falhas: [{ metodo: 'unlink', ondeIgual: `${m.orfaos[0].relPasta}/exibicao.webp`, codigo: 'ENOENT' }] });
    const r = await executar(m, { fs: sumiu.fs });
    assert.deepEqual(r.falhas, []);
    assert.deepEqual(r.removidos[0].arquivos.map((f) => f.nome), ['mestre.png', 'miniatura.webp']);
    assert.equal(r.resumo.bytesLiberados, 420);
  });
});

describe('[EXE] a espera pela trava da biblioteca é limitada', () => {
  test('EXE-08 — `set_config(lock_timeout, "<tempo>ms", local)` vem DEPOIS do BEGIN READ COMMITTED READ ONLY e ANTES da trava, na mesma transação, com o tempo pedido', async () => {
    const m = mundo({ orfaos: [{ semente: 'exe8', idadeMin: 3 * DIA }] });
    const vistos = [];
    const banco = a.criarBancoDeLimpeza({ empresas: [7], empresa: m.registradas.map((i) => i.linha), eventos: m.eventos, aoConsultar: (sql, params) => { vistos.push([sql, params]); } });
    await S.limparOrfaos(banco, {
      diretorio: m.raiz, fs: m.fs, agora: () => AGORA, executar: true, intervaloBackupMinutos: 60, ...comJanela(m), tempoMaximoDaTravaMs: 1234,
    });
    const i = vistos.findIndex(([sql]) => /set_config\('lock_timeout'/i.test(sql));
    assert.ok(i > 0, 'o lock_timeout foi configurado');
    assert.deepEqual(vistos[i][1], ['1234ms']);
    assert.match(vistos[i - 1][0], /^BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY$/);
    assert.match(vistos[i + 1][0], /advisory/i);
    assert.match(vistos[i][0], /, true\)$/, 'configuração local à transação');
  });
});

describe('[EXE] `bytesLiberados` conta SÓ o que de fato saiu (decisão de 19/10/2026)', () => {
  test('EXE-10 — falha PARCIAL: o segundo unlink falha (EIO): só o primeiro arquivo saiu; o conjunto vai para `falhas`, nunca para `removidos`, e `bytesLiberados` conta SÓ o que saiu (os 300 bytes do arquivo cuja remoção falhou NÃO contam)', async () => {
    const m = mundo({ orfaos: [{ semente: 'exe10', idadeMin: 3 * DIA }] });
    const quebrado = a.fachadaDeLimpeza(m.raiz, { eventos: m.eventos, falhas: [{ metodo: 'unlink', ondeIgual: `${m.orfaos[0].relPasta}/mestre.png`, codigo: 'EIO' }] });
    const r = await executar(m, { fs: quebrado.fs });
    assert.deepEqual(r.removidos, []);
    assert.deepEqual(r.falhas.map((f) => [f.codigo, f.codigoSistema]), [['FALHA_AO_REMOVER', 'EIO']]);
    assert.equal(r.resumo.bytesLiberados, 120, 'só o exibicao.webp (120 bytes) saiu; o mestre.png (300) falhou e não conta, e o miniatura.webp nem foi tentado');
    assert.deepEqual(m.orfaos[0].nomes(), ['mestre.png', 'miniatura.webp']);
    assert.equal(r.janela.estado, 'LIBERADA');
  });

  test('EXE-11 — rmdir recusado por PERMISSÃO (EACCES) não é "pasta cheia": os três arquivos saíram e contam em `bytesLiberados` (540), mas o conjunto vai para `falhas`, nunca para `removidos`', async () => {
    const m = mundo({ orfaos: [{ semente: 'exe11', idadeMin: 3 * DIA }] });
    const quebrado = a.fachadaDeLimpeza(m.raiz, { eventos: m.eventos, falhas: [{ metodo: 'rmdir', ondeContem: m.orfaos[0].hash, codigo: 'EACCES' }] });
    const r = await executar(m, { fs: quebrado.fs });
    assert.deepEqual(r.removidos, []);
    assert.deepEqual(r.falhas.map((f) => f.codigoSistema), ['EACCES']);
    assert.equal(r.resumo.bytesLiberados, 540, 'os três arquivos saíram de fato: contam, mesmo com o rmdir recusado');
    assert.deepEqual(m.orfaos[0].nomes(), []);
  });
});
