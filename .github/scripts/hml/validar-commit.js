'use strict';

/**
 * Validação do commit escolhido para a homologação (deploy-hml.yml, job
 * "validar"). Função pura sobre fatos já coletados pelo workflow, para ser
 * testada sem GitHub, Git ou credenciais.
 *
 * Fatos: { commit, cabecaMain, ancestral, execucoesCi, permitirAnterior, agora }
 *   commit        SHA completo informado no disparo manual
 *   cabecaMain    SHA da cabeça atual da main no momento da execução
 *   ancestral     resultado de `git merge-base --is-ancestor <commit> main`
 *   execucoesCi   execuções do workflow CI para esse SHA (API do GitHub)
 *   permitirAnterior  entrada explícita para rollback de código
 *
 * Fail-closed: qualquer fato ausente ou fora do esperado recusa. Um commit que
 * não é a cabeça da main só passa com permitirAnterior e sai rotulado como
 * retroativo, para nunca ser confundido com a versão atual.
 */

const fs = require('node:fs');

const SHA_COMPLETO = /^[0-9a-f]{40}$/;
const CI_CAMINHO = '.github/workflows/ci.yml';

class RecusaHml extends Error {
  constructor(codigo, mensagem) {
    super(mensagem);
    this.name = 'RecusaHml';
    this.codigo = codigo;
  }
}

function ciVerdeNaMain(execucoesCi, commit) {
  if (!Array.isArray(execucoesCi)) return false;
  return execucoesCi.some((e) => e && typeof e === 'object'
    && e.head_sha === commit
    && typeof e.path === 'string' && e.path.split('@')[0] === CI_CAMINHO
    && e.event === 'push'
    && e.head_branch === 'main'
    && e.status === 'completed'
    && e.conclusion === 'success');
}

function rotuloDe(commit, atual, agora) {
  const data = new Date(agora);
  if (Number.isNaN(data.getTime())) throw new RecusaHml('FATO_INVALIDO', 'data da execução inválida');
  const carimbo = data.toISOString().replace(/[-:]/g, '').slice(0, 15);
  return `hml-${carimbo}-${commit.slice(0, 7)}${atual ? '' : '-retroativo'}`;
}

function validarCommit(fatos) {
  if (!fatos || typeof fatos !== 'object') throw new RecusaHml('FATO_INVALIDO', 'fatos ausentes');
  const { commit, cabecaMain, ancestral, execucoesCi, permitirAnterior = false, agora = Date.now() } = fatos;
  if (typeof commit !== 'string' || !SHA_COMPLETO.test(commit)) {
    throw new RecusaHml('COMMIT_INVALIDO', 'informe o SHA completo do commit, 40 caracteres hexadecimais minúsculos');
  }
  if (typeof cabecaMain !== 'string' || !SHA_COMPLETO.test(cabecaMain)) {
    throw new RecusaHml('FATO_INVALIDO', 'cabeça da main não identificada');
  }
  if (ancestral !== true) throw new RecusaHml('FORA_DA_MAIN', 'o commit não pertence à história da main');
  if (!ciVerdeNaMain(execucoesCi, commit)) {
    throw new RecusaHml('CI_NAO_VERDE', 'nenhuma execução do CI concluída com sucesso para esse commit no push da main');
  }
  const atual = commit === cabecaMain;
  if (!atual && permitirAnterior !== true) {
    throw new RecusaHml('COMMIT_ANTERIOR', `o commit não é a cabeça atual da main (${cabecaMain.slice(0, 7)}); rollback de código exige permitir_commit_anterior`);
  }
  return { ok: true, commit, atual, rotulo: rotuloDe(commit, atual, agora), cabecaMain };
}

function escreverSaidas(resultado, arquivoSaidas) {
  const linhas = [`rotulo=${resultado.rotulo}`, `atual=${resultado.atual}`, `commit=${resultado.commit}`];
  fs.appendFileSync(arquivoSaidas, `${linhas.join('\n')}\n`);
}

if (require.main === module) {
  const argumentos = process.argv.slice(2);
  const arquivoFatos = argumentos.length === 2 && argumentos[0] === '--fatos' ? argumentos[1] : null;
  try {
    if (!arquivoFatos) throw new RecusaHml('USO', 'uso: validar-commit.js --fatos <arquivo.json>');
    const resultado = validarCommit(JSON.parse(fs.readFileSync(arquivoFatos, 'utf8')));
    if (process.env.GITHUB_OUTPUT) escreverSaidas(resultado, process.env.GITHUB_OUTPUT);
    console.log(`Commit aceito: ${resultado.commit} (${resultado.atual ? 'cabeça atual da main' : 'ANTERIOR à main atual, retroativo'}); release ${resultado.rotulo}`);
  } catch (erro) {
    console.error(`Homologação recusada (${erro.codigo || 'ERRO'}): ${erro.message}`);
    process.exitCode = 1;
  }
}

module.exports = { validarCommit, ciVerdeNaMain, rotuloDe, RecusaHml, SHA_COMPLETO, CI_CAMINHO };
