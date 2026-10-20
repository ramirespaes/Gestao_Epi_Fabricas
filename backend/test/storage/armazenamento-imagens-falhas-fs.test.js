'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { chaveOraculo, sha256De, bytesAleatorios, MAX } = require('./helpers/contrato-armazenamento-imagens');
const { criarRaizTemporaria, removerTemporarioSeguro, pendentes } = require('./helpers/tmp-seguro');

/**
 * Biblioteca de Imagens, Unidade 1 (complemento ao ARM-15): falhas REAIS do sistema de arquivos (permissão negada) não vazam o caminho,
 * a chave, o código do sistema operacional nem propriedades do erro original. Cada falha é provocada em um diretório temporário
 * exclusivo, com permissão restrita, e as permissões são restauradas antes da limpeza.
 */
const SEM_PERMISSAO_REAL = (typeof process.getuid === 'function' && process.getuid() === 0) || process.platform === 'win32';
const OPCOES = { skip: SEM_PERMISSAO_REAL && 'exige POSIX e um usuário sem privilégio de administrador' };
const MENSAGEM_GENERICA = 'falha no armazenamento de imagens';

function exigirErroGenerico(falha, raiz, sha) {
  assert.equal(falha.codigo, 'ARMAZENAMENTO_FALHOU');
  assert.equal(falha.message, MENSAGEM_GENERICA);
  assert.deepEqual(Object.keys(falha), ['codigo'], 'sem path, syscall, errno nem cause do erro original');
  const tudo = `${falha.message}\n${falha.stack}`;
  for (const proibido of [raiz, os.tmpdir(), sha, 'EACCES', 'EPERM', 'ENOENT', 'permission denied']) {
    assert.ok(!tudo.toLowerCase().includes(proibido.toLowerCase()), `vazou: ${proibido === raiz ? '<raiz>' : proibido}`);
  }
  return true;
}

async function comRaiz(corpo) {
  const raiz = criarRaizTemporaria();
  try { await corpo(raiz, criarArmazenamentoImagens({ diretorio: raiz })); } finally {
    for (const pasta of [raiz, path.join(raiz, '5'), path.join(raiz, '5', 'x')]) { try { fs.chmodSync(pasta, 0o700); } catch { /* inexistente */ } }
    removerTemporarioSeguro(raiz);
  }
}

describe('[ARM-15b] erros reais do sistema de arquivos viram ARMAZENAMENTO_FALHOU, sem vazar nada', () => {
  test('gravar em uma raiz sem permissão de escrita', OPCOES, () => comRaiz(async (raiz, a) => {
    const bytes = bytesAleatorios(64);
    const sha = sha256De(bytes);
    fs.chmodSync(raiz, 0o500);
    await assert.rejects(a.gravar(chaveOraculo({ empresaId: 5, sha }), bytes, { maxBytes: MAX }), (falha) => exigirErroGenerico(falha, raiz, sha));
    fs.chmodSync(raiz, 0o700);
    assert.deepEqual(fs.readdirSync(raiz), [], 'nada foi criado');
  }));

  test('abrir um arquivo sem permissão de leitura', OPCOES, () => comRaiz(async (raiz, a) => {
    const bytes = bytesAleatorios(64);
    const sha = sha256De(bytes);
    const chave = chaveOraculo({ empresaId: 5, sha });
    await a.gravar(chave, bytes, { maxBytes: MAX });
    fs.chmodSync(path.join(raiz, chave), 0o000);
    await assert.rejects(a.abrir(chave), (falha) => exigirErroGenerico(falha, raiz, sha));
  }));

  test('remover quando a pasta do arquivo não permite apagar', OPCOES, () => comRaiz(async (raiz, a) => {
    const bytes = bytesAleatorios(64);
    const sha = sha256De(bytes);
    const chave = chaveOraculo({ empresaId: 5, sha });
    await a.gravar(chave, bytes, { maxBytes: MAX });
    fs.chmodSync(path.join(raiz, '5', sha), 0o500);
    await assert.rejects(a.remover(chave), (falha) => exigirErroGenerico(falha, raiz, sha));
    fs.chmodSync(path.join(raiz, '5', sha), 0o700);
    assert.equal(fs.existsSync(path.join(raiz, chave)), true, 'o arquivo continua íntegro');
  }));

  test('listar uma pasta de empresa sem permissão de leitura', OPCOES, () => comRaiz(async (raiz, a) => {
    const bytes = bytesAleatorios(64);
    await a.gravar(chaveOraculo({ empresaId: 5, sha: sha256De(bytes) }), bytes, { maxBytes: MAX });
    fs.chmodSync(path.join(raiz, '5'), 0o000);
    await assert.rejects(a.listar('5'), (falha) => exigirErroGenerico(falha, raiz, 'x'.repeat(64)));
  }));

  test('removerVariantes quando a pasta da imagem não permite apagar', OPCOES, () => comRaiz(async (raiz, a) => {
    const bytes = bytesAleatorios(64);
    const sha = sha256De(bytes);
    await a.gravar(chaveOraculo({ empresaId: 5, sha }), bytes, { maxBytes: MAX });
    fs.chmodSync(path.join(raiz, '5', sha), 0o500);
    await assert.rejects(a.removerVariantes({ escopo: 'EMPRESA', empresaId: 5, sha256: sha }), (falha) => exigirErroGenerico(falha, raiz, sha));
    fs.chmodSync(path.join(raiz, '5', sha), 0o700);
  }));
});

after(() => {
  assert.deepEqual(pendentes(), [], 'todo diretório temporário criado pelos testes foi removido');
});
