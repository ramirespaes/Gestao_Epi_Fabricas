'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

/**
 * Auxiliar dos testes de armazenamento de imagens (Biblioteca de Imagens, Unidade 1).
 *
 * Todo teste que escreve em disco usa UM diretório temporário exclusivo, criado por `mkdtemp` dentro do temporário do sistema
 * e registrado aqui. A limpeza só remove diretório que ESTE módulo criou nesta execução; qualquer outro caminho (a raiz, o
 * diretório pessoal, o projeto, o próprio temporário, um caminho com "..", um link simbólico) é recusado ANTES de apagar.
 * Nenhuma função aqui lê variável de ambiente de configuração da aplicação nem toca em pasta real de imagens, de backup ou
 * de documentos.
 */

const PREFIXO = 'gepi-img-teste-';
const criados = new Set();

const baseTemporaria = () => fs.realpathSync(os.tmpdir());

/** Cria um diretório temporário exclusivo (caminho canônico) e o registra. */
function criarRaizTemporaria() {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(baseTemporaria(), PREFIXO)));
  criados.add(dir);
  return dir;
}

/** Remove somente um diretório criado por criarRaizTemporaria nesta execução; recusa tudo o mais, sem apagar nada. */
function removerTemporarioSeguro(dir) {
  if (typeof dir !== 'string' || dir === '' || dir.includes('\0') || !path.isAbsolute(dir)) {
    throw new Error('remoção recusada: caminho inválido');
  }
  if (path.resolve(dir) !== dir) throw new Error('remoção recusada: caminho não canônico');
  if (!criados.has(dir)) throw new Error('remoção recusada: o diretório não foi criado por este teste');
  if (path.dirname(dir) !== baseTemporaria() || !path.basename(dir).startsWith(PREFIXO)) {
    throw new Error('remoção recusada: fora do temporário exclusivo');
  }
  const estado = fs.lstatSync(dir);
  if (estado.isSymbolicLink() || !estado.isDirectory()) throw new Error('remoção recusada: não é um diretório comum');
  fs.rmSync(dir, { recursive: true, force: true });
  criados.delete(dir);
}

/** Diretórios temporários criados e ainda não removidos (deve ficar vazio ao fim de cada arquivo de teste). */
const pendentes = () => [...criados];

/** Todos os arquivos (não diretórios) sob a raiz, como caminhos relativos ordenados; links não são seguidos. */
function arquivosSob(raiz) {
  const achados = [];
  const andar = (dir) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const completo = path.join(dir, entrada.name);
      if (entrada.isDirectory()) andar(completo);
      else achados.push(path.relative(raiz, completo));
    }
  };
  andar(raiz);
  return achados.sort();
}

module.exports = { PREFIXO, criarRaizTemporaria, removerTemporarioSeguro, pendentes, arquivosSob, baseTemporaria };
