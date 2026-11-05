'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { criarRaizTemporaria } = require('../storage/helpers/tmp-seguro');

/**
 * Ambiente FICTÍCIO e completo para os testes do diagnóstico do backup (G-A): árvore de dados, árvore do backup, binários falsos do
 * PostgreSQL e um arquivo de senha com conteúdo que NUNCA pode aparecer nas saídas. Tudo em um diretório temporário exclusivo.
 */

const SEGREDO_NO_ARQUIVO = 'localhost:5432:banco_ficticio:usuario_ficticio:SENHA-QUE-NAO-PODE-VAZAR-9f3c';

function diretorio(caminho) {
  fs.mkdirSync(caminho, { recursive: true });
  fs.chmodSync(caminho, 0o700);
  return caminho;
}

function montarAmbiente() {
  const raiz = criarRaizTemporaria();
  const dados = diretorio(path.join(raiz, 'data'));
  const imagens = diretorio(path.join(dados, 'imagens-material'));
  const fiscalizacao = diretorio(path.join(dados, 'fiscalizacao'));
  const backup = diretorio(path.join(raiz, 'backup'));
  const subdiretorios = {};
  for (const sub of ['preparacoes', 'dumps', 'publicados', 'controle', 'controle/janela', 'controle/diario', 'controle/registros']) {
    subdiretorios[sub] = diretorio(path.join(backup, sub));
  }
  const binarios = diretorio(path.join(raiz, 'pgbin'));
  for (const nome of ['pg_dump', 'pg_restore']) {
    fs.writeFileSync(path.join(binarios, nome), '#!/bin/sh\nexit 0\n');
    fs.chmodSync(path.join(binarios, nome), 0o755);
  }
  const segredos = diretorio(path.join(raiz, 'secrets'));
  const senha = path.join(segredos, 'pgpass-backup');
  fs.writeFileSync(senha, `${SEGREDO_NO_ARQUIVO}\n`, { mode: 0o600 });
  fs.chmodSync(senha, 0o600);
  const codigo = diretorio(path.join(raiz, 'codigo'));
  const arquivoDaJanela = path.join(subdiretorios['controle/janela'], 'imagens.lock');

  const ambiente = {
    IMAGENS_ARMAZENAMENTO_DIRETORIO: imagens,
    FISCALIZACAO_ARMAZENAMENTO_DIRETORIO: fiscalizacao,
    IMAGENS_JANELA_ESCRITA_ARQUIVO: arquivoDaJanela,
    BACKUP_RAIZ: backup,
    BACKUP_PG_BINARIOS: binarios,
    BACKUP_PG_HOST: '127.0.0.1',
    BACKUP_PG_PORTA: '5432',
    BACKUP_PG_USUARIO: 'usuario_ficticio',
    BACKUP_PG_BANCO: 'banco_ficticio',
    PGPASSFILE: senha,
    BACKUP_LIMITE_DUMP_BYTES: String(64 * 1024 * 1024),
    BACKUP_LIMITE_TOTAL_BYTES: String(512 * 1024 * 1024),
    BACKUP_LIMITE_LIVRE_BYTES: '1024',
  };
  return { raiz, ambiente, caminhos: { dados, imagens, fiscalizacao, backup, subdiretorios, binarios, segredos, senha, codigo, arquivoDaJanela } };
}

/** Instantâneo de TUDO sob `dir` (caminho relativo, tipo, modo, tamanho, mtime): igual antes e depois prova que nada foi criado nem alterado. */
function instantaneo(dir) {
  const linhas = [];
  const andar = (atual) => {
    for (const nome of fs.readdirSync(atual).sort()) {
      const completo = path.join(atual, nome);
      const e = fs.lstatSync(completo);
      linhas.push(`${path.relative(dir, completo)}|${e.isDirectory() ? 'd' : e.isSymbolicLink() ? 'l' : 'f'}|${(e.mode & 0o777).toString(8)}|${e.size}|${e.mtimeMs}`);
      if (e.isDirectory()) andar(completo);
    }
  };
  andar(dir);
  return linhas.join('\n');
}

module.exports = { montarAmbiente, instantaneo, SEGREDO_NO_ARQUIVO };
