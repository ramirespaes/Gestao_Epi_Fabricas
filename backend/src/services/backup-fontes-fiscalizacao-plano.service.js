'use strict';

const repositorio = require('../repositories/fiscalizacao-verificacao.repository');

/**
 * Fonte `fiscalizacao-pacotes` (D-ORF-6, P3): PLANEJADOR. `planejarPacotes({ pacotes })` é função PURA: não acessa banco, disco, rede nem processo, não recalcula hash
 * e não altera a entrada. Recebe as referências como o repositório as entrega (`{ id, empresaId, status, tamanhoBytes, sha256, chaveArmazenamento }`) e devolve, em ordem
 * crescente de `chave`, só os pacotes CONCLUIDO: `[{ chave, sha256, bytes, empresaId, pacoteId }]`. GERANDO e FALHA não têm arquivo esperado e ficam fora do plano.
 * Qualquer linha inconsistente (status desconhecido; CONCLUIDO com chave fora do formato, id ou empresa da chave diferentes da linha, hash ou tamanho inválidos) ou chave
 * repetida LANÇA Error com `code: 'PLANO_INVALIDO'`, sem resultado parcial e sem valores recebidos na mensagem: um plano parcial seria um backup incompleto silencioso.
 * Os SHA-256 e tamanhos são DECLARAÇÕES do banco; a cópia verificada confere os bytes. `lerReferencias(executor)` lê as linhas dentro da transação que o chamador
 * já abriu (o snapshot do backup), sem abrir transação própria.
 */

const CHAVE_FORMATO = /^([1-9][0-9]{0,14})\/pacote-([1-9][0-9]{0,14})\.zip$/;
const SHA256 = /^[0-9a-f]{64}$/;
const TAMANHO_MAXIMO = 1024 * 1024 * 1024;
const STATUS = Object.freeze(['CONCLUIDO', 'GERANDO', 'FALHA']);

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const inteiroTexto = (v) => typeof v === 'string' && /^[1-9][0-9]{0,14}$/.test(v);

function invalido() {
  const falha = new Error('plano de backup da fiscalização inválido');
  falha.code = 'PLANO_INVALIDO';
  return falha;
}

function planejarPacotes(entrada) {
  if (!ehObjeto(entrada) || Reflect.ownKeys(entrada).length !== 1 || !Array.isArray(entrada.pacotes)) throw invalido();
  const itens = [];
  const chaves = new Set();
  for (const linha of entrada.pacotes) {
    if (!ehObjeto(linha) || !inteiroTexto(linha.id) || !inteiroTexto(linha.empresaId) || !STATUS.includes(linha.status)) throw invalido();
    if (linha.status !== 'CONCLUIDO') continue;
    const m = typeof linha.chaveArmazenamento === 'string' ? CHAVE_FORMATO.exec(linha.chaveArmazenamento) : null;
    if (m === null || m[1] !== linha.empresaId || m[2] !== linha.id) throw invalido();
    if (!(typeof linha.sha256 === 'string' && SHA256.test(linha.sha256))) throw invalido();
    if (!(Number.isInteger(linha.tamanhoBytes) && linha.tamanhoBytes > 0 && linha.tamanhoBytes <= TAMANHO_MAXIMO)) throw invalido();
    if (chaves.has(linha.chaveArmazenamento)) throw invalido();
    chaves.add(linha.chaveArmazenamento);
    itens.push(Object.freeze({ chave: linha.chaveArmazenamento, sha256: linha.sha256, bytes: linha.tamanhoBytes, empresaId: linha.empresaId, pacoteId: linha.id }));
  }
  itens.sort((a, b) => (a.chave < b.chave ? -1 : a.chave > b.chave ? 1 : 0));
  return Object.freeze(itens);
}

/** Todas as referências, paginadas por id, no executor recebido (a transação é do chamador). */
async function lerReferencias(executor, { tamanhoDaPagina = 500 } = {}) {
  if (executor === null || typeof executor !== 'object' || typeof executor.query !== 'function') throw new TypeError('executor inválido');
  const todos = [];
  let depoisDe = '0';
  for (;;) {
    const pagina = await repositorio.listarPacotes(executor, { depoisDe, limite: tamanhoDaPagina });
    todos.push(...pagina);
    if (pagina.length < tamanhoDaPagina) return Object.freeze(todos);
    depoisDe = pagina[pagina.length - 1].id;
  }
}

module.exports = { planejarPacotes, lerReferencias, CHAVE_FORMATO, TAMANHO_MAXIMO };
