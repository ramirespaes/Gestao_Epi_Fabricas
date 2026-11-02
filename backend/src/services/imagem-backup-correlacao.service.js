'use strict';

const { ehEvidenciaFisica } = require('./imagem-backup-evidencia-dump.service');
const { ehEvidenciaEstrutural, ESTRUTURA_NAO_EXECUTADA, ORIGEM_ESTRUTURAL } = require('./imagem-backup-estrutura.service');

/**
 * Backup permanente da Biblioteca de Imagens (D-ORF-6, GREEN integrado E4): CORRELAÇÃO CONTRATUAL das evidências de uma operação. Módulo interno e folha, usado pelo executor (que forma a correlação do dump), pelo
 * encadeamento (que acrescenta o manifesto e a selagem verificados) e pelo avaliador (que a confere). NÃO é fábrica pública de correlação: `formarCorrelacao` só aceita evidências T1/T2 PRODUZIDAS pelo observador do
 * dump (marca em memória do módulo de evidência) e uma supervisão já normalizada; objetos literais, clones e cópias nunca são reconhecidos.
 *
 * `correlacao` = { escopo: 'DUMP' | 'CONJUNTO', snapshot: { operacaoId, snapshotId }, supervisao, dump: { operacaoId, identidade, bytes, sha256, t2 }, manifesto?: { operacaoId, conjuntoId, sha256Manifesto, preparacao, selado, verificado } }.
 * O resultado de T2 entra na correlação JÁ no momento da formação (o executor executa T2 antes de formá-la); `operacaoId` nunca é acrescentado depois a um resultado desvinculado.
 *
 * `avaliarCorrelacao(valor)` -> { satisfeita, escopo, motivos } (congelado, motivos fixos, sem eco de valores). Correlação contratual satisfeita NÃO é backup operacionalmente válido: a procedência do relatório operacional
 * continua pendente.
 *
 * LIMITES: a marca prova que o objeto foi produzido por estes componentes neste processo (WeakSet), NÃO autorização operacional; T1/T2 demonstram integridade física ENTRE observações, não a origem independente dos bytes
 * escritos pelo `pg_dump`; o manifesto acrescentado depende da honestidade do encadeamento que o fornece, dentro do mesmo processo.
 */

const correlacoesProduzidas = new WeakSet();
const SHA256 = /^[0-9a-f]{64}$/;
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const MOTIVOS = Object.freeze({
  CORRELACAO_AUSENTE: 'CORRELACAO_AUSENTE',
  CORRELACAO_SEM_ORIGEM: 'CORRELACAO_SEM_ORIGEM',
  CORRELACAO_OPERACAO_DIVERGENTE: 'CORRELACAO_OPERACAO_DIVERGENTE',
  CORRELACAO_SNAPSHOT_INVALIDO: 'CORRELACAO_SNAPSHOT_INVALIDO',
  CORRELACAO_SUPERVISAO_NAO_CONCLUIDA: 'CORRELACAO_SUPERVISAO_NAO_CONCLUIDA',
  CORRELACAO_DUMP_INCOMPLETO: 'CORRELACAO_DUMP_INCOMPLETO',
  CORRELACAO_T2_RECUSADO: 'CORRELACAO_T2_RECUSADO',
  CORRELACAO_T2_DIVERGENTE: 'CORRELACAO_T2_DIVERGENTE',
  CORRELACAO_MANIFESTO_INVALIDO: 'CORRELACAO_MANIFESTO_INVALIDO',
  CORRELACAO_ESTRUTURA_DIVERGENTE: 'CORRELACAO_ESTRUTURA_DIVERGENTE',
});

function erro() {
  return new TypeError('correlação inválida');
}

const mesmaIdentidade = (a, b) => ehObjeto(a) && ehObjeto(b) && a.dev === b.dev && a.ino === b.ino;

/** Forma a correlação do DUMP. Exige evidências reconhecidas; qualquer outra coisa lança um erro genérico, sem eco. */
function formarCorrelacao({ operacaoId, snapshotId, supervisao, observacao, t2, estrutura = ESTRUTURA_NAO_EXECUTADA }) {
  if (typeof operacaoId !== 'string' || typeof snapshotId !== 'string' || !ehObjeto(supervisao)) throw erro();
  if (!ehEvidenciaFisica(observacao) || observacao.ok !== true || !ehEvidenciaFisica(t2)) throw erro();
  if (observacao.operacaoId !== operacaoId || t2.operacaoId !== operacaoId) throw erro();
  if (!ehEvidenciaEstrutural(estrutura)) throw erro(); // só a evidência produzida pelo verificador estrutural (ou a constante "não executada") entra na correlação
  const correlacao = Object.freeze({
    escopo: 'DUMP',
    snapshot: Object.freeze({ operacaoId, snapshotId }),
    supervisao,
    estrutura,
    dump: Object.freeze({
      operacaoId,
      identidade: observacao.identidade,
      bytes: observacao.bytes,
      sha256: observacao.sha256,
      t2,
    }),
  });
  correlacoesProduzidas.add(correlacao);
  return correlacao;
}

/** Acrescenta o manifesto e a selagem VERIFICADOS (digest vindo da verificação existente) a uma correlação já reconhecida; devolve outra correlação reconhecida de escopo CONJUNTO. */
function acrescentarManifesto(base, manifesto) {
  if (!ehObjeto(base) || !correlacoesProduzidas.has(base) || base.escopo !== 'DUMP') throw erro();
  if (!ehObjeto(manifesto)) throw erro();
  const { operacaoId, conjuntoId, sha256Manifesto, preparacao } = manifesto;
  if (operacaoId !== base.snapshot.operacaoId || typeof conjuntoId !== 'string' || conjuntoId === '' || typeof sha256Manifesto !== 'string' || !SHA256.test(sha256Manifesto) || typeof preparacao !== 'string' || preparacao === '') throw erro();
  const completa = Object.freeze({
    ...base,
    escopo: 'CONJUNTO',
    manifesto: Object.freeze({ operacaoId, conjuntoId, sha256Manifesto, preparacao, selado: true, verificado: true }),
  });
  correlacoesProduzidas.add(completa);
  return completa;
}

const reconhecerCorrelacao = (valor) => ehObjeto(valor) && correlacoesProduzidas.has(valor);

function resultado(motivos, escopo) {
  const unicos = [...new Set(motivos)];
  return Object.freeze({ satisfeita: unicos.length === 0, escopo, motivos: Object.freeze(unicos) });
}

function avaliarCorrelacao(valor) {
  if (valor === undefined || valor === null) return resultado([MOTIVOS.CORRELACAO_AUSENTE], null);
  if (!reconhecerCorrelacao(valor)) return resultado([MOTIVOS.CORRELACAO_SEM_ORIGEM], null);
  const motivos = [];
  const { snapshot, supervisao, dump, manifesto } = valor;
  const operacaoId = snapshot.operacaoId;

  if (typeof snapshot.snapshotId !== 'string' || snapshot.snapshotId === '') motivos.push(MOTIVOS.CORRELACAO_SNAPSHOT_INVALIDO);
  if (supervisao.operacaoId !== operacaoId || dump.operacaoId !== operacaoId || dump.t2.operacaoId !== operacaoId) motivos.push(MOTIVOS.CORRELACAO_OPERACAO_DIVERGENTE);
  if (supervisao.concluido !== true || supervisao.saida !== 0 || supervisao.liberarTravaPermitido !== true) motivos.push(MOTIVOS.CORRELACAO_SUPERVISAO_NAO_CONCLUIDA);
  if (!Number.isSafeInteger(dump.bytes) || dump.bytes <= 0 || typeof dump.sha256 !== 'string' || !SHA256.test(dump.sha256) || !ehObjeto(dump.identidade)) motivos.push(MOTIVOS.CORRELACAO_DUMP_INCOMPLETO);
  if (dump.t2.ok !== true) motivos.push(MOTIVOS.CORRELACAO_T2_RECUSADO);
  else if (dump.t2.bytes !== dump.bytes || dump.t2.sha256 !== dump.sha256 || !mesmaIdentidade(dump.t2.identidade, dump.identidade)) motivos.push(MOTIVOS.CORRELACAO_T2_DIVERGENTE);
  // Estrutura (Marco C): quando EXECUTADA, precisa ser do mesmo artefato e da mesma operação. A estrutura não executada/recusada não invalida a correlação contratual, mas bloqueia a publicação (ver `estruturaVerificada`).
  const estrutura = valor.estrutura;
  if (estrutura.concluida === true && (estrutura.operacaoId !== operacaoId || estrutura.sha256 !== dump.sha256 || estrutura.bytes !== dump.bytes || !mesmaIdentidade(estrutura.identidade, dump.identidade))) motivos.push(MOTIVOS.CORRELACAO_ESTRUTURA_DIVERGENTE);
  if (valor.escopo === 'CONJUNTO') {
    if (!ehObjeto(manifesto) || manifesto.operacaoId !== operacaoId || manifesto.selado !== true || manifesto.verificado !== true || !SHA256.test(manifesto.sha256Manifesto)) motivos.push(MOTIVOS.CORRELACAO_MANIFESTO_INVALIDO);
  }
  return resultado(motivos, valor.escopo);
}

/** A estrutura foi verificada (limitadamente, `pg_restore --list` supervisionado) para o MESMO artefato e a MESMA operação desta correlação reconhecida. NÃO prova restauração. */
function estruturaVerificada(correlacao) {
  if (!reconhecerCorrelacao(correlacao)) return false;
  const { estrutura, dump, snapshot } = correlacao;
  return ehEvidenciaEstrutural(estrutura) && estrutura.ok === true && estrutura.origem === ORIGEM_ESTRUTURAL
    && estrutura.operacaoId === snapshot.operacaoId && estrutura.sha256 === dump.sha256 && estrutura.bytes === dump.bytes && mesmaIdentidade(estrutura.identidade, dump.identidade);
}

module.exports = { formarCorrelacao, acrescentarManifesto, reconhecerCorrelacao, avaliarCorrelacao, estruturaVerificada, MOTIVOS_DA_CORRELACAO: MOTIVOS };
