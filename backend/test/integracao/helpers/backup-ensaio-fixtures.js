'use strict';

const assert = require('node:assert/strict');
const cp = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Rotinas compartilhadas dos ensaios PostgreSQL do backup (B3 ponta a ponta e H9H-B1): localização dos binários PostgreSQL 16 e semeadura de imagens padrão SINTÉTICAS.
 * Só isto. Este módulo NÃO inicia ensaio, NÃO lê o ambiente global por conta própria (recebe `env` por parâmetro), NÃO aplica migrations, NÃO abre conexão e NÃO decide autorização:
 * os opt-ins (`SWB_*`), as portas protegidas, o socket exclusivo, a identidade da instância, o processo filho, o cleanup e os testes negativos continuam em cada suíte.
 */

const LIMITE_BYTES_IMAGEM = 1024;
const SQL_IMAGEM_PADRAO = 'INSERT INTO imagens_padrao (nome, arquivo_origem, sha256, sha256_miniatura, formato, largura, altura, bytes_mestre, bytes_miniatura) VALUES ($1, $2, $3, $4, $5, 256, 256, $6, $7)';
const sha256 = (conteudo) => crypto.createHash('sha256').update(conteudo).digest('hex');

/**
 * Binários `pg_dump` e `pg_restore` da versão 16 em `env.BACKUP_PG_BINARIOS`: diretório absoluto e canônico (sem links), os dois executáveis, e `pg_dump --version` com ambiente vazio
 * respondendo 16. Qualquer desvio lança (AssertionError ou erro do sistema de arquivos/processo); nada é devolvido pela metade.
 */
function localizarBinarios(env) {
  const dir = env.BACKUP_PG_BINARIOS;
  assert.ok(typeof dir === 'string' && path.isAbsolute(dir) && fs.realpathSync(dir) === dir, 'BACKUP_PG_BINARIOS ausente ou não canônico');
  const binarios = { dump: path.join(dir, 'pg_dump'), restore: path.join(dir, 'pg_restore') };
  for (const b of Object.values(binarios)) fs.accessSync(b, fs.constants.X_OK);
  const versao = cp.execFileSync(binarios.dump, ['--version'], { env: {}, timeout: 10000, encoding: 'utf8' });
  assert.match(versao, /^pg_dump \(PostgreSQL\) 16\./);
  return binarios;
}

/**
 * Semeia `quantidade` imagens padrão sintéticas (padrão 2): grava mestre e miniatura no `armazenamento` (limite de 1024 bytes por arquivo, caminho `padrao/<sha256 do mestre>/…`) e
 * insere a linha em `imagens_padrao` pelo `cliente`, com parâmetros SQL (nunca concatenados). Devolve `[{ h, mestre, mini }]` na ordem. Dependências explícitas: `armazenamento.gravar` e
 * `cliente.query`; a primeira falha de qualquer uma interrompe a semeadura e se propaga, sem engolir o erro.
 */
async function semearImagensSinteticas({ armazenamento, cliente, nomeOrigem, quantidade = 2 }) {
  assert.ok(armazenamento !== null && typeof armazenamento === 'object' && typeof armazenamento.gravar === 'function', 'armazenamento sem gravar');
  assert.ok(cliente !== null && typeof cliente === 'object' && typeof cliente.query === 'function', 'cliente sem query');
  assert.ok(typeof nomeOrigem === 'string' && nomeOrigem !== '', 'nome da origem ausente');
  assert.ok(Number.isInteger(quantidade) && quantidade >= 1 && quantidade <= 10, 'quantidade fora de 1 a 10');
  const imagens = [];
  for (let n = 1; n <= quantidade; n += 1) {
    const mestre = Buffer.from(`png-ficticio-${n}-${nomeOrigem}`);
    const mini = Buffer.from(`webp-mini-${n}-${nomeOrigem}`);
    const h = sha256(mestre);
    await armazenamento.gravar(`padrao/${h}/mestre.png`, mestre, { maxBytes: LIMITE_BYTES_IMAGEM });
    await armazenamento.gravar(`padrao/${h}/miniatura.webp`, mini, { maxBytes: LIMITE_BYTES_IMAGEM });
    await cliente.query(SQL_IMAGEM_PADRAO, [`Imagem ${n}`, `imagem-${n}.png`, h, sha256(mini), 'PNG', mestre.length, mini.length]);
    imagens.push({ h, mestre, mini });
  }
  return imagens;
}

module.exports = { localizarBinarios, semearImagensSinteticas, LIMITE_BYTES_IMAGEM, SQL_IMAGEM_PADRAO };
