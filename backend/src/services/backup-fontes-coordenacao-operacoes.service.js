'use strict';

/**
 * D-ORF-6, P10 (R2 §13 D3/D4/D5; planejamento rodada 9 "travas, repetição/idempotência e recuperação de travas"): COORDENAÇÃO DE OPERAÇÕES INCOMPATÍVEIS
 * no MESMO banco PostgreSQL, por advisory locks de sessão. Executor por parâmetro (nunca o pool global); nada aqui lê ambiente, abre conexão ou escreve em
 * tabela: `pg_try_advisory_lock` / `pg_advisory_unlock` são funções de sessão, sem efeito persistente e liberadas automaticamente se a sessão cair.
 *
 * MATRIZ (fechada): BACKUP × RESTAURACAO × MIGRACAO × LIMPEZA. Backup e migração são incompatíveis (DDL durante o snapshot/dump); restauração num banco
 * NOVO não disputa nada do banco de origem, mas é incompatível com migração no banco DESTINO (mesmo executor); limpeza × backup já é coberta pela janela de
 * arquivos (CONS-02) e aqui só se ESPELHA (o advisory lock não substitui a janela). A chave do cadeado do D-ORF-6 é fixa (`CHAVE_DORF6`); o cadeado do
 * `node-pg-migrate` (`PG_MIGRATE_LOCK_ID`) é tomado pelo backup para que uma migração/CD concorrente FALHE RÁPIDO (`advisoryLockMode: 'fail'` em
 * `scripts/migrate.js`) em vez de esperar — e vice-versa: com uma migração em curso, o backup não começa.
 *
 * `adquirirExclusao(executor, { operacao })` -> `{ ok:true, operacao, cadeados:[...], liberar() }` | `{ ok:false, motivo:'EM_USO'|'MIGRACAO_EM_CURSO'|'CONSULTA_FALHOU' }`.
 * Falha fechada: qualquer cadeado que não possa ser tomado libera os já tomados e recusa; nada espera (sem deadlock). `liberar()` devolve `{ liberados }`.
 *
 * ALERTA DE JANELA OBSOLETA (D4): `avaliarIdadeDaJanela({ janela, agora, limiarMs })` classifica a trava de arquivo (documento lido por `lerJanela`) como
 * `AUSENTE` | `RECENTE` | `OBSOLETA` | `INVALIDA`; NUNCA remove nada (recuperação de trava é decisão humana, I3).
 *
 * HISTÓRICO (D-F13): este módulo não grava histórico; o diário NDJSON existente (`imagem-backup-diario-execucao`) e `logs_auditoria` ficam para a decisão.
 */

const OPERACOES = Object.freeze(['BACKUP', 'RESTAURACAO', 'MIGRACAO', 'LIMPEZA']);
// true = incompatíveis (exclusão mútua obrigatória)
const INCOMPATIBILIDADES = Object.freeze({
  BACKUP: Object.freeze({ BACKUP: true, RESTAURACAO: false, MIGRACAO: true, LIMPEZA: true }),
  RESTAURACAO: Object.freeze({ BACKUP: false, RESTAURACAO: true, MIGRACAO: true, LIMPEZA: false }),
  MIGRACAO: Object.freeze({ BACKUP: true, RESTAURACAO: true, MIGRACAO: true, LIMPEZA: true }),
  LIMPEZA: Object.freeze({ BACKUP: true, RESTAURACAO: false, MIGRACAO: true, LIMPEZA: true }),
});
// Chaves de advisory lock (bigint): uma por operação do D-ORF-6, fixas e documentadas; a de migração é a do node-pg-migrate.
const PG_MIGRATE_LOCK_ID = 7241865325823964n;
const CHAVE_DORF6 = Object.freeze({ BACKUP: 7241865325823965n, RESTAURACAO: 7241865325823966n, LIMPEZA: 7241865325823967n, MIGRACAO: PG_MIGRATE_LOCK_ID });
const SQL_PERMITIDO = /^SELECT pg_(?:try_advisory_lock|advisory_unlock)\((?:0|[1-9][0-9]{0,18})\) AS (?:tomado|liberado)$/;
const JANELA_POLITICA = Object.freeze({ limiarPadraoMs: 6 * 60 * 60 * 1000 });

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
function entradaInvalida(motivo) {
  const e = new TypeError('coordenação inválida');
  e.code = 'ENTRADA_INVALIDA';
  e.motivo = motivo;
  return e;
}

/** Cadeados que a operação precisa segurar: o próprio e os das operações incompatíveis (cada chave uma vez, em ordem fixa). */
function cadeadosDe(operacao) {
  if (!OPERACOES.includes(operacao)) throw entradaInvalida('OPERACAO');
  const chaves = new Set([CHAVE_DORF6[operacao]]);
  for (const outra of OPERACOES) if (INCOMPATIBILIDADES[operacao][outra]) chaves.add(CHAVE_DORF6[outra]);
  return Object.freeze([...chaves].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
}
const compativeis = (a, b) => {
  if (!OPERACOES.includes(a) || !OPERACOES.includes(b)) throw entradaInvalida('OPERACAO');
  return INCOMPATIBILIDADES[a][b] === false;
};

async function consultar(executor, sql) {
  if (!SQL_PERMITIDO.test(sql)) throw entradaInvalida('SQL');
  const r = await executor.query(sql);
  if (!ehObjeto(r) || !Array.isArray(r.rows) || r.rows.length !== 1 || !ehObjeto(r.rows[0])) throw entradaInvalida('RESPOSTA');
  const valor = r.rows[0].tomado ?? r.rows[0].liberado;
  if (typeof valor !== 'boolean') throw entradaInvalida('RESPOSTA');
  return valor;
}

async function adquirirExclusao(executor, entrada) {
  if (!ehObjeto(executor) || typeof executor.query !== 'function') throw entradaInvalida('EXECUTOR');
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => k === 'operacao')) throw entradaInvalida('ENTRADA');
  const { operacao } = entrada;
  const chaves = cadeadosDe(operacao);
  const tomados = [];
  const liberarTudo = async () => {
    let liberados = 0;
    for (const chave of [...tomados].reverse()) { try { if (await consultar(executor, `SELECT pg_advisory_unlock(${chave}) AS liberado`)) liberados += 1; } catch { /* sessão pode ter caído: o cadeado morre com ela */ } }
    tomados.length = 0;
    return Object.freeze({ liberados });
  };
  for (const chave of chaves) {
    let tomado;
    try { tomado = await consultar(executor, `SELECT pg_try_advisory_lock(${chave}) AS tomado`); } catch { await liberarTudo(); return Object.freeze({ ok: false, motivo: 'CONSULTA_FALHOU', operacao }); }
    if (!tomado) { await liberarTudo(); return Object.freeze({ ok: false, motivo: chave === PG_MIGRATE_LOCK_ID ? 'MIGRACAO_EM_CURSO' : 'EM_USO', operacao, chave: String(chave) }); }
    tomados.push(chave);
  }
  let liberada = false;
  return Object.freeze({
    ok: true, operacao, cadeados: Object.freeze(chaves.map(String)),
    async liberar() { if (liberada) return Object.freeze({ liberados: 0 }); liberada = true; return liberarTudo(); },
  });
}

const INSTANTE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
/** D4: idade da janela de escrita lida do arquivo; nunca remove. */
function avaliarIdadeDaJanela(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => ['janela', 'agora', 'limiarMs'].includes(k))) throw entradaInvalida('ENTRADA');
  const { janela, agora } = entrada;
  const limiarMs = entrada.limiarMs === undefined ? JANELA_POLITICA.limiarPadraoMs : entrada.limiarMs;
  if (!(agora instanceof Date) || Number.isNaN(agora.getTime()) || !Number.isSafeInteger(limiarMs) || limiarMs <= 0) throw entradaInvalida('ENTRADA');
  if (janela === null) return Object.freeze({ classe: 'AUSENTE', idadeMs: null, alerta: false, acao: 'NENHUMA' });
  if (!ehObjeto(janela) || typeof janela.iniciadoEm !== 'string' || !INSTANTE.test(janela.iniciadoEm) || typeof janela.tipo !== 'string') return Object.freeze({ classe: 'INVALIDA', idadeMs: null, alerta: true, acao: 'DECISAO_HUMANA' });
  const idadeMs = agora.getTime() - Date.parse(janela.iniciadoEm);
  if (idadeMs < 0) return Object.freeze({ classe: 'INVALIDA', idadeMs, alerta: true, acao: 'DECISAO_HUMANA', tipo: janela.tipo });
  const obsoleta = idadeMs > limiarMs;
  return Object.freeze({ classe: obsoleta ? 'OBSOLETA' : 'RECENTE', idadeMs, alerta: obsoleta, acao: obsoleta ? 'DECISAO_HUMANA' : 'NENHUMA', tipo: janela.tipo, limiarMs });
}

module.exports = { OPERACOES, INCOMPATIBILIDADES, CHAVE_DORF6, PG_MIGRATE_LOCK_ID, JANELA_POLITICA, cadeadosDe, compativeis, adquirirExclusao, avaliarIdadeDaJanela };
