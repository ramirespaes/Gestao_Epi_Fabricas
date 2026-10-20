'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough } = require('node:stream');
const { exigirModulo } = require('../helpers/exigir-modulo');
const {
  rodarContrato, chaveOraculo, sha256De, bytesAleatorios, lerStream, esperar, rejeitaComCodigo, H, MAX,
} = require('./helpers/contrato-armazenamento-imagens');
const { criarArmazenamentoMemoriaFalso } = require('./helpers/armazenamento-memoria-falso');
const {
  criarRaizTemporaria, removerTemporarioSeguro, pendentes, arquivosSob,
} = require('./helpers/tmp-seguro');

/**
 * Biblioteca de Imagens, Unidade 1 (RED): armazenamento de imagens (contratos ARM-01 a ARM-13 do doc. 14).
 * Módulo de produção previsto: src/storage/armazenamento-imagens.js com `criarArmazenamentoImagens({ diretorio })`
 * (operações gravar, abrir, existe, remover, removerVariantes e listar) e `chaveDe(...)`, também exportada no nível do módulo
 * para um driver S3 reaproveitar as MESMAS regras de chave.
 *
 * Duas partes:
 *  1. a SUÍTE DE CONTRATO (helpers/contrato-armazenamento-imagens.js), executada contra o driver local (RED: o módulo ainda não
 *     existe) e contra um driver FALSO em memória (calibração: prova que o contrato é coerente e que cabe num armazenamento sem
 *     disco, como o S3);
 *  2. os testes específicos do disco: chave, permissões, link simbólico, temporários e resíduos.
 *
 * SEGURANÇA DOS TESTES: só escrevem em diretórios temporários EXCLUSIVOS criados por eles (helpers/tmp-seguro.js). Nunca usam a
 * pasta configurada da aplicação, imagens de empresa, backups, documentos nem o diretório do PostgreSQL; a limpeza recusa
 * qualquer caminho que não tenha sido criado pelo próprio teste.
 */
const M = () => exigirModulo('src/storage/armazenamento-imagens');
const POSIX = process.platform !== 'win32';
const SO_POSIX = { skip: !POSIX && 'depende de permissões e links POSIX' };

/** Cria o módulo ANTES do diretório: se o módulo não existe, o teste falha sem criar nada em disco. */
async function criarLocal() {
  const modulo = M();
  const raiz = criarRaizTemporaria();
  const armazenamento = modulo.criarArmazenamentoImagens({ diretorio: raiz });
  return { armazenamento, raiz, limpar: async () => { removerTemporarioSeguro(raiz); } };
}

async function comLocal(corpo) {
  const contexto = await criarLocal();
  try { await corpo(contexto.armazenamento, contexto.raiz, contexto); } finally { await contexto.limpar(); }
}

const modo = (caminho) => fs.statSync(caminho).mode & 0o777;
async function esperarArquivos(raiz) {
  for (let i = 0; i < 40; i += 1) {
    const achados = arquivosSob(raiz);
    if (achados.length > 0) return achados;
    await esperar(50);
  }
  return [];
}

// ───────────────────────── 1. suíte de contrato ─────────────────────────

rodarContrato({ nome: 'driver local (src/storage/armazenamento-imagens.js)', criar: criarLocal });
rodarContrato({ nome: 'driver FALSO em memória (calibração do contrato)', criar: async () => ({ armazenamento: criarArmazenamentoMemoriaFalso(), limpar: async () => {} }) });

// ───────────────────────── 2. específicos do disco ─────────────────────────

describe('[ARM-02] a chave é montada SÓ a partir de valores validados', () => {
  const SHA = 'c'.repeat(64);

  test('formato exato e extensão pelo formato; a biblioteca padrão tem namespace próprio', () => {
    const { chaveDe } = M();
    assert.equal(typeof chaveDe, 'function', 'chaveDe é exportada no nível do módulo (reutilizável por outro driver)');
    const casos = [
      [{ escopo: 'EMPRESA', empresaId: 12, sha256: SHA, variante: 'mestre', formato: 'PNG' }, chaveOraculo({ empresaId: 12, sha: SHA, variante: 'mestre', ext: 'png' })],
      [{ escopo: 'EMPRESA', empresaId: 12, sha256: SHA, variante: 'mestre', formato: 'JPEG' }, chaveOraculo({ empresaId: 12, sha: SHA, variante: 'mestre', ext: 'jpg' })],
      [{ escopo: 'EMPRESA', empresaId: 12, sha256: SHA, variante: 'mestre', formato: 'WEBP' }, chaveOraculo({ empresaId: 12, sha: SHA, variante: 'mestre', ext: 'webp' })],
      [{ escopo: 'EMPRESA', empresaId: 3, sha256: SHA, variante: 'exibicao', formato: 'WEBP' }, chaveOraculo({ empresaId: 3, sha: SHA, variante: 'exibicao' })],
      [{ escopo: 'EMPRESA', empresaId: 3, sha256: SHA, variante: 'miniatura', formato: 'WEBP' }, chaveOraculo({ empresaId: 3, sha: SHA, variante: 'miniatura' })],
      [{ escopo: 'PADRAO', sha256: SHA, variante: 'mestre', formato: 'PNG' }, chaveOraculo({ empresaId: 'padrao', sha: SHA, variante: 'mestre', ext: 'png' })],
      [{ escopo: 'PADRAO', sha256: SHA, variante: 'miniatura', formato: 'WEBP' }, chaveOraculo({ empresaId: 'padrao', sha: SHA, variante: 'miniatura' })],
    ];
    for (const [entrada, esperada] of casos) assert.equal(chaveDe(entrada), esperada, JSON.stringify(entrada));
    assert.ok(chaveDe(casos[5][0]).startsWith('padrao/'), 'a biblioteca padrão não usa identificador de empresa');
    assert.ok(!/^[0-9]+\//.test(chaveDe(casos[5][0])));
  });

  test('entradas inválidas são recusadas com CHAVE_INVALIDA, sem ecoar o valor', () => {
    const { chaveDe } = M();
    const base = { escopo: 'EMPRESA', empresaId: 1, sha256: SHA, variante: 'mestre', formato: 'PNG' };
    const invalidas = [
      { ...base, empresaId: 0 }, { ...base, empresaId: -1 }, { ...base, empresaId: 1.5 }, { ...base, empresaId: '1' }, { ...base, empresaId: '01' },
      { ...base, empresaId: 'padrao' }, { ...base, empresaId: NaN }, { ...base, empresaId: Infinity }, { ...base, empresaId: 2 ** 53 }, { ...base, empresaId: undefined },
      { ...base, empresaId: null }, { ...base, empresaId: 1e15 },
      { ...base, escopo: 'PADRAO' }, // a biblioteca padrão não aceita empresa
      { ...base, escopo: 'OUTRO' }, { ...base, escopo: 'empresa' }, { ...base, escopo: undefined },
      { ...base, sha256: SHA.toUpperCase() }, { ...base, sha256: SHA.slice(1) }, { ...base, sha256: `${SHA}0` }, { ...base, sha256: `${'z'.repeat(64)}` },
      { ...base, sha256: '../'.repeat(21) + 'a' }, { ...base, sha256: `${'a'.repeat(30)}/${'a'.repeat(33)}` }, { ...base, sha256: undefined },
      { ...base, variante: 'original' }, { ...base, variante: 'MESTRE' }, { ...base, variante: '../mestre' }, { ...base, variante: undefined },
      { ...base, formato: 'GIF' }, { ...base, formato: 'png' }, { ...base, formato: undefined }, { ...base, formato: 'SVG' },
      { ...base, variante: 'miniatura', formato: 'PNG' }, { ...base, variante: 'miniatura', formato: 'JPEG' },
      { ...base, variante: 'exibicao', formato: 'PNG' }, { ...base, variante: 'exibicao', formato: 'JPEG' },
      null, undefined, 'texto', 42, [],
    ];
    for (const entrada of invalidas) {
      assert.throws(() => chaveDe(entrada), (falha) => {
        assert.equal(falha.codigo, 'CHAVE_INVALIDA', JSON.stringify(entrada));
        return true;
      }, JSON.stringify(entrada));
    }
    assert.throws(() => chaveDe({ ...base, sha256: '../SEGREDO-NA-CHAVE' }), (falha) => { assert.doesNotMatch(falha.message, /SEGREDO/); return true; });
  });

  test('a instância expõe a MESMA função e toda chave gerada é aceita pelas operações (ida e volta)', () => comLocal(async (a) => {
    const { chaveDe } = M();
    assert.equal(a.chaveDe, chaveDe);
    const bytes = bytesAleatorios(300);
    const sha = sha256De(bytes);
    const chaves = [
      chaveDe({ escopo: 'EMPRESA', empresaId: 4, sha256: sha, variante: 'mestre', formato: 'JPEG' }),
      chaveDe({ escopo: 'EMPRESA', empresaId: 4, sha256: sha, variante: 'exibicao', formato: 'WEBP' }),
      chaveDe({ escopo: 'EMPRESA', empresaId: 4, sha256: sha, variante: 'miniatura', formato: 'WEBP' }),
    ];
    for (const chave of chaves) await a.gravar(chave, bytes, { maxBytes: MAX });
    assert.deepEqual(await a.listar('4'), [...chaves].sort());
  }));
});

describe('[ARM-14] construção do armazenamento local', () => {
  test('o diretório é obrigatório, absoluto e sem NUL; criado, fica só do dono (0700); a instância não expõe o caminho', SO_POSIX, async () => {
    const { criarArmazenamentoImagens } = M();
    assert.throws(() => criarArmazenamentoImagens({}), /diretório/i);
    assert.throws(() => criarArmazenamentoImagens(), /diretório/i);
    assert.throws(() => criarArmazenamentoImagens({ diretorio: 42 }), /diretório/i);
    assert.throws(() => criarArmazenamentoImagens({ diretorio: 'relativo' }), /absoluto/i);
    assert.throws(() => criarArmazenamentoImagens({ diretorio: '' }), /diretório/i);
    const raiz = criarRaizTemporaria();
    try {
      assert.throws(() => criarArmazenamentoImagens({ diretorio: `${raiz}/a\0b` }), /diretório|inválido/i);
      const novo = path.join(raiz, 'novo');
      const a = criarArmazenamentoImagens({ diretorio: novo });
      assert.equal(modo(novo), 0o700);
      assert.equal(JSON.stringify(Object.keys(a)).includes(raiz), false);
      assert.equal(JSON.stringify(a).includes(raiz), false);
      assert.deepEqual(arquivosSob(raiz), [], 'a construção não cria arquivos');
    } finally { removerTemporarioSeguro(raiz); }
  });
});

describe('[ARM-07] permissões restritas', () => {
  test('a raiz, a pasta da empresa, a pasta do hash e a da biblioteca padrão ficam 0700; os arquivos 0600', SO_POSIX, () => comLocal(async (a, raiz) => {
    const bytes = bytesAleatorios();
    const sha = sha256De(bytes);
    const kEmpresa = chaveOraculo({ empresaId: 7, sha });
    const kPadrao = chaveOraculo({ empresaId: 'padrao', sha, variante: 'miniatura' });
    await a.gravar(kEmpresa, bytes, { maxBytes: MAX });
    await a.gravar(kPadrao, bytes, { maxBytes: MAX });
    for (const pasta of [raiz, path.join(raiz, '7'), path.join(raiz, '7', sha), path.join(raiz, 'padrao'), path.join(raiz, 'padrao', sha)]) {
      assert.equal(modo(pasta), 0o700, pasta.replace(raiz, '<raiz>'));
    }
    for (const chave of [kEmpresa, kPadrao]) assert.equal(modo(path.join(raiz, chave)), 0o600, chave);
  }));
});

describe('[ARM-03b] link simbólico não leva para fora da raiz', () => {
  test('pasta da empresa que é link para fora: toda operação recusa e nada é escrito fora', SO_POSIX, () => comLocal(async (a, raiz) => {
    const fora = criarRaizTemporaria();
    try {
      fs.symlinkSync(fora, path.join(raiz, '7'));
      const bytes = bytesAleatorios(64);
      const chave = chaveOraculo({ empresaId: 7, sha: sha256De(bytes) });
      await rejeitaComCodigo(() => a.gravar(chave, bytes, { maxBytes: MAX }), 'CHAVE_INVALIDA', 'gravar');
      await rejeitaComCodigo(() => a.abrir(chave), 'CHAVE_INVALIDA', 'abrir');
      await rejeitaComCodigo(() => a.existe(chave), 'CHAVE_INVALIDA', 'existe');
      await rejeitaComCodigo(() => a.remover(chave), 'CHAVE_INVALIDA', 'remover');
      await rejeitaComCodigo(() => a.listar('7'), 'CHAVE_INVALIDA', 'listar');
      await rejeitaComCodigo(() => a.removerVariantes({ escopo: 'EMPRESA', empresaId: 7, sha256: sha256De(bytes) }), 'CHAVE_INVALIDA', 'removerVariantes');
      assert.deepEqual(arquivosSob(fora), [], 'nada foi escrito fora da raiz');
    } finally { removerTemporarioSeguro(fora); }
  }));

  test('arquivo que é link para um arquivo de fora: não é lido, sobrescrito nem apagado', SO_POSIX, () => comLocal(async (a, raiz) => {
    const fora = criarRaizTemporaria();
    try {
      const bytes = bytesAleatorios(64);
      const sha = sha256De(bytes);
      const chave = chaveOraculo({ empresaId: 8, sha });
      await a.gravar(chave, bytes, { maxBytes: MAX });
      const alvo = path.join(fora, 'segredo.txt');
      fs.writeFileSync(alvo, 'CONTEUDO-SECRETO-DE-FORA', { mode: 0o600 });
      fs.unlinkSync(path.join(raiz, chave));
      fs.symlinkSync(alvo, path.join(raiz, chave));
      let lido = null;
      try { lido = await lerStream(await a.abrir(chave)); } catch { lido = null; }
      assert.equal(lido, null, 'o conteúdo do arquivo de fora não pode ser lido');
      await assert.rejects(a.gravar(chave, bytesAleatorios(64), { maxBytes: MAX }));
      await assert.rejects(a.remover(chave));
      assert.equal(fs.readFileSync(alvo, 'utf8'), 'CONTEUDO-SECRETO-DE-FORA', 'o arquivo de fora continua intacto');
    } finally { removerTemporarioSeguro(fora); }
  }));
});

describe('[ARM-04c] temporário com permissão restrita e publicação só ao final', () => {
  test('durante a escrita só existe um arquivo temporário (.tmp, 0600) dentro da raiz; ao fim só a chave definitiva', SO_POSIX, () => comLocal(async (a, raiz) => {
    const bytes = bytesAleatorios(5000);
    const chave = chaveOraculo({ empresaId: 11, sha: sha256De(bytes) });
    const fonte = new PassThrough();
    const promessa = a.gravar(chave, fonte, { maxBytes: MAX });
    fonte.write(bytes.subarray(0, 2000));
    const durante = await esperarArquivos(raiz);
    assert.ok(durante.length >= 1, 'a escrita vai para um temporário em disco, não só para a memória');
    for (const relativo of durante) {
      assert.ok(relativo.endsWith('.tmp'), `arquivo inesperado durante a escrita: ${relativo}`);
      assert.equal(modo(path.join(raiz, relativo)), 0o600, relativo);
      assert.notEqual(relativo, chave);
    }
    assert.equal(fs.existsSync(path.join(raiz, chave)), false, 'a chave definitiva ainda não existe');
    fonte.end(bytes.subarray(2000));
    await promessa;
    assert.deepEqual(arquivosSob(raiz), [chave], 'depois de publicar não sobra temporário');
    assert.equal(modo(path.join(raiz, chave)), 0o600);
  }));
});

describe('[ARM-08b] falhas simuladas não deixam arquivo publicado parcialmente nem resíduo', () => {
  test('stream com erro, limite, SHA-256 divergente, conteúdo diferente e aborto: o disco fica só com o que foi publicado inteiro', () => comLocal(async (a, raiz) => {
    const bytes = bytesAleatorios(3000);
    const sha = sha256De(bytes);
    const novaChave = (i) => chaveOraculo({ empresaId: 20 + i, sha });
    // sem nenhuma gravação bem-sucedida
    const f1 = new PassThrough();
    const p1 = a.gravar(novaChave(1), f1, { maxBytes: MAX });
    f1.write(bytes.subarray(0, 500));
    f1.destroy(new Error('queda simulada'));
    await assert.rejects(p1);
    await rejeitaComCodigo(() => a.gravar(novaChave(2), bytes, { maxBytes: 10 }), 'LIMITE_BYTES_EXCEDIDO', 'limite');
    await rejeitaComCodigo(() => a.gravar(novaChave(3), bytes, { maxBytes: MAX, sha256Esperado: 'f'.repeat(64) }), 'INTEGRIDADE_DIVERGENTE', 'integridade');
    const controle = new AbortController();
    const f4 = new PassThrough();
    const p4 = a.gravar(novaChave(4), f4, { maxBytes: MAX, signal: controle.signal });
    f4.write(bytes.subarray(0, 500));
    await esperar(40);
    controle.abort();
    await assert.rejects(p4, (falha) => falha.codigo === 'GRAVACAO_ABORTADA');
    f4.destroy();
    assert.deepEqual(arquivosSob(raiz), [], 'nenhum arquivo (nem temporário) depois de cinco falhas');
    // com um arquivo já publicado, as falhas não o tocam
    const chave = novaChave(5);
    await a.gravar(chave, bytes, { maxBytes: MAX });
    await rejeitaComCodigo(() => a.gravar(chave, bytesAleatorios(3000), { maxBytes: MAX }), 'CHAVE_COM_CONTEUDO_DIFERENTE', 'conteúdo diferente');
    const f6 = new PassThrough();
    const p6 = a.gravar(chave, f6, { maxBytes: MAX });
    f6.write(Buffer.from('parcial'));
    f6.destroy(new Error('queda simulada 2'));
    await assert.rejects(p6);
    assert.deepEqual(arquivosSob(raiz), [chave]);
    assert.ok(fs.readFileSync(path.join(raiz, chave)).equals(bytes));
  }));
});

describe('[ARM-13] temporário abandonado e arquivos estranhos', () => {
  test('um temporário deixado por uma queda não impede a próxima gravação da mesma chave nem aparece em listar', () => comLocal(async (a, raiz) => {
    const bytes = bytesAleatorios(500);
    const sha = sha256De(bytes);
    const chave = chaveOraculo({ empresaId: 7, sha });
    const pasta = path.join(raiz, '7', sha);
    fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
    for (const nome of ['mestre.png.tmp', 'mestre.png.123abc.tmp', '.tmp']) fs.writeFileSync(path.join(pasta, nome), 'resto-de-queda', { mode: 0o600 });
    const resultado = await a.gravar(chave, bytes, { maxBytes: MAX });
    assert.equal(resultado.reaproveitado, false);
    assert.deepEqual(await a.listar('7'), [chave]);
    assert.ok(fs.readFileSync(path.join(raiz, chave)).equals(bytes));
  }));

  test('listar ignora arquivos e pastas estranhos', () => comLocal(async (a, raiz) => {
    const bytes = bytesAleatorios(100);
    const sha = sha256De(bytes);
    const chave = chaveOraculo({ empresaId: 7, sha });
    await a.gravar(chave, bytes, { maxBytes: MAX });
    fs.writeFileSync(path.join(raiz, '7', 'lixo.txt'), 'x');
    fs.mkdirSync(path.join(raiz, '7', 'nao-e-hash'));
    fs.writeFileSync(path.join(raiz, '7', 'nao-e-hash', 'mestre.png'), 'x');
    fs.writeFileSync(path.join(raiz, '7', sha, 'nota.txt'), 'x');
    fs.writeFileSync(path.join(raiz, '7', sha, 'mestre.gif'), 'x');
    fs.writeFileSync(path.join(raiz, '7', sha, 'MESTRE.png'), 'x');
    assert.deepEqual(await a.listar('7'), [chave]);
  }));
});

describe('[ARM-15] as mensagens de erro do driver local nunca levam o caminho da raiz', () => {
  test('conteúdo diferente, limite, integridade e ausente', () => comLocal(async (a, raiz) => {
    const bytes = bytesAleatorios(200);
    const sha = sha256De(bytes);
    const chave = chaveOraculo({ empresaId: 7, sha });
    await a.gravar(chave, bytes, { maxBytes: MAX });
    const tentativas = [
      () => a.gravar(chave, bytesAleatorios(200), { maxBytes: MAX }),
      () => a.gravar(chaveOraculo({ empresaId: 7, sha: H }), bytes, { maxBytes: 10 }),
      () => a.gravar(chaveOraculo({ empresaId: 7, sha: H }), bytes, { maxBytes: MAX, sha256Esperado: 'f'.repeat(64) }),
      () => a.abrir(chaveOraculo({ empresaId: 7, sha: H })),
    ];
    for (const tentar of tentativas) {
      await assert.rejects(tentar(), (falha) => {
        assert.ok(typeof falha.codigo === 'string' && falha.codigo.length > 0);
        assert.ok(!falha.message.includes(raiz), 'a mensagem vazou a raiz');
        assert.ok(!falha.message.includes(os.tmpdir()), 'a mensagem vazou o temporário');
        return true;
      });
    }
  }));
});

// ───────────────────────── 3. auxiliar de limpeza segura (calibração: roda hoje) ─────────────────────────

describe('[AUX] a limpeza dos testes só remove o diretório temporário que o próprio teste criou', () => {
  test('recusa a raiz, o diretório pessoal, o projeto, o temporário do sistema, caminhos relativos, não canônicos, com NUL e links — sem apagar nada', SO_POSIX, () => {
    const projeto = path.resolve(__dirname, '..', '..', '..');
    const exclusivo = criarRaizTemporaria();
    const alvoDoLink = criarRaizTemporaria(); // alvo inofensivo: nenhum link aponta para uma pasta real
    const link = path.join(exclusivo, 'atalho');
    fs.symlinkSync(alvoDoLink, link);
    const protegidos = ['/', os.homedir(), process.cwd(), projeto, os.tmpdir(), fs.realpathSync(os.tmpdir()), 'relativo', './x', `${exclusivo}/../x`, `${exclusivo}\0x`, '', null, undefined, 42, link, path.dirname(exclusivo)];
    try {
      for (const alvo of protegidos) {
        assert.throws(() => removerTemporarioSeguro(alvo), /remoção recusada/, String(alvo));
      }
      for (const real of ['/', os.homedir(), projeto, fs.realpathSync(os.tmpdir())]) assert.equal(fs.existsSync(real), true, `${real} continua existindo`);
      assert.equal(fs.existsSync(path.join(projeto, 'backend', 'package.json')), true, 'o projeto não foi tocado');
      assert.equal(fs.existsSync(alvoDoLink), true, 'o alvo do link não foi tocado');
    } finally {
      fs.unlinkSync(link);
      removerTemporarioSeguro(exclusivo);
      removerTemporarioSeguro(alvoDoLink);
    }
  });

  test('remove o diretório exclusivo (com conteúdo) e não aceita removê-lo duas vezes', () => {
    const exclusivo = criarRaizTemporaria();
    fs.mkdirSync(path.join(exclusivo, 'a', 'b'), { recursive: true });
    fs.writeFileSync(path.join(exclusivo, 'a', 'b', 'x.bin'), 'x');
    assert.ok(pendentes().includes(exclusivo));
    removerTemporarioSeguro(exclusivo);
    assert.equal(fs.existsSync(exclusivo), false);
    assert.ok(!pendentes().includes(exclusivo));
    assert.throws(() => removerTemporarioSeguro(exclusivo), /remoção recusada/);
  });

  test('um diretório temporário que NÃO foi criado pelo auxiliar é recusado mesmo estando no temporário do sistema', () => {
    const alheio = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gepi-img-teste-alheio-'));
    try {
      assert.throws(() => removerTemporarioSeguro(alheio), /remoção recusada/);
      assert.equal(fs.existsSync(alheio), true);
    } finally { fs.rmdirSync(alheio); }
  });
});

after(() => {
  assert.deepEqual(pendentes(), [], 'todo diretório temporário criado pelos testes foi removido');
});
