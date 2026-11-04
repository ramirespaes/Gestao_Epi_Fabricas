'use strict';

const crypto = require('node:crypto');

/**
 * D-ORF-6, P12 (planejamento rodada 11; R2 §11.4, §13.2 D6, D-F8): PROCEDIMENTO DE RECUPERAÇÃO DE DESASTRES — plano, ensaio e evidência, tudo PURO.
 * Nada aqui restaura, conecta ou lança processo: os passos são executados pelos módulos já aprovados (decifra do contêiner, selagem/leitor L2, restaurador do
 * banco, `restaurarL2` com conciliação P7) e este módulo só ordena, mede e julga. Produção continua PROIBIDA (política de destino; D-F8): o ensaio é sempre em
 * banco/diretório NOVOS e o veredito nunca promove `recuperavelEmProducao`.
 *
 * `planejarEnsaioDeDR({ ultimoBackupEm, agora, alvos: { rpoMs, rtoMs } })` -> plano com `rpoMedidoMs` (idade do último backup), `rpoAtendido` e a lista FIXA de passos
 * (ordem obrigatória, cada um com critério de aceite): DECIFRAR → VERIFICACOES_8_7 → BANCO → ESQUEMA → ARQUIVOS_POR_FONTE → CONCILIACAO → VEREDITO.
 * `avaliarEnsaioDeDR({ plano, passos: [{ id, ok, inicioEm, fimEm, detalhe? }], restauracao })`: passos na ordem do plano (fora de ordem/faltante = INCOMPLETO),
 * `rtoMedidoMs` = fim do último passo − início do primeiro, `rtoAtendido`; classe `RECUPERADO` (tudo ok, veredito INTEGRO, RPO e RTO atendidos),
 * `RECUPERADO_FORA_DO_ALVO` (íntegro mas RPO/RTO estourados), `PARCIAL` (restauração INCOMPLETO/INCONSISTENTE ou passo falho depois do banco — D-F9: parcial por
 * empresa NÃO existe; parcial aqui = fontes não íntegras, registrado e nunca aceito como recuperado), `FALHOU` (falha antes do banco ou passo faltante).
 * `linhaDeEvidencia(resultado)`: uma linha NDJSON canônica com SHA-256 próprio, sem caminhos nem segredos, para o diário/auditoria (D-F13).
 */

const PASSOS = Object.freeze([
  { id: 'DECIFRAR', criterio: 'contêiner decifrado em destino novo; envelope autenticado; nenhum arquivo adulterado' },
  { id: 'VERIFICACOES_8_7', criterio: 'selagem relida pelo leitor L2 com layout mínimo 2; conjunto exato e SHA-256 de cada arquivo' },
  { id: 'BANCO', criterio: 'pg_restore supervisionado em banco NOVO com prefixo da política; código 0' },
  { id: 'ESQUEMA', criterio: 'migrations do banco restaurado IGUAL às do código (6.4)' },
  { id: 'ARQUIVOS_POR_FONTE', criterio: 'cada fonte restaurada em destino novo pelo seu adaptador; contagens iguais ao manifesto' },
  { id: 'CONCILIACAO', criterio: 'referências do banco restaurado × arquivos restaurados: INTEGRO em todas as fontes (M-ISO)' },
  { id: 'VEREDITO', criterio: 'avaliarRestauracao INTEGRO; recuperavelEmProducao continua falso' },
].map(Object.freeze));
const CLASSES = Object.freeze(['RECUPERADO', 'RECUPERADO_FORA_DO_ALVO', 'PARCIAL', 'FALHOU']);
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/;
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const instante = (v) => (typeof v === 'string' && ISO.test(v) ? Date.parse(v) : NaN);
function entradaInvalida(motivo) { const e = new TypeError('entrada de DR inválida'); e.code = 'ENTRADA_INVALIDA'; e.motivo = motivo; return e; }

function planejarEnsaioDeDR(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => ['ultimoBackupEm', 'agora', 'alvos'].includes(k))) throw entradaInvalida('ENTRADA');
  const { ultimoBackupEm, agora, alvos } = entrada;
  const t0 = instante(ultimoBackupEm);
  const t1 = instante(agora);
  if (Number.isNaN(t0) || Number.isNaN(t1) || t1 < t0) throw entradaInvalida('INSTANTES');
  if (!ehObjeto(alvos) || !Number.isSafeInteger(alvos.rpoMs) || alvos.rpoMs <= 0 || !Number.isSafeInteger(alvos.rtoMs) || alvos.rtoMs <= 0) throw entradaInvalida('ALVOS');
  const rpoMedidoMs = t1 - t0;
  return Object.freeze({
    versao: 1, ultimoBackupEm, agora, alvos: Object.freeze({ rpoMs: alvos.rpoMs, rtoMs: alvos.rtoMs }), rpoMedidoMs, rpoAtendido: rpoMedidoMs <= alvos.rpoMs,
    passos: PASSOS, limites: Object.freeze(['SEM_PITR: RPO = intervalo entre backups', 'PRODUCAO_PROIBIDA: destino sempre novo (D-F8)', 'SEM_RESTAURACAO_PARCIAL_POR_EMPRESA (D-F9)']),
  });
}

function avaliarEnsaioDeDR(entrada) {
  if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => ['plano', 'passos', 'restauracao'].includes(k))) throw entradaInvalida('ENTRADA');
  const { plano, passos, restauracao } = entrada;
  if (!ehObjeto(plano) || plano.versao !== 1 || !Array.isArray(passos) || !ehObjeto(restauracao)) throw entradaInvalida('ENTRADA');
  const motivos = [];
  let inicio = null;
  let fim = null;
  let ultimoFim = null;
  let falhouEm = null;
  const executados = [];
  for (let i = 0; i < PASSOS.length; i += 1) {
    const esperado = PASSOS[i].id;
    const p = passos[i];
    if (!ehObjeto(p) || p.id !== esperado) { motivos.push(`PASSO_FALTANTE_OU_FORA_DE_ORDEM:${esperado}`); break; }
    const a = instante(p.inicioEm);
    const b = instante(p.fimEm);
    if (typeof p.ok !== 'boolean' || Number.isNaN(a) || Number.isNaN(b) || b < a || (ultimoFim !== null && a < ultimoFim)) { motivos.push(`PASSO_INVALIDO:${esperado}`); break; }
    if (inicio === null) inicio = a;
    fim = b;
    ultimoFim = b;
    executados.push(Object.freeze({ id: esperado, ok: p.ok, duracaoMs: b - a }));
    if (!p.ok) { falhouEm = esperado; motivos.push(`PASSO_FALHOU:${esperado}`); break; }
  }
  const completo = executados.length === PASSOS.length && falhouEm === null;
  const rtoMedidoMs = inicio === null || fim === null ? null : fim - inicio;
  const rtoAtendido = rtoMedidoMs !== null && rtoMedidoMs <= plano.alvos.rtoMs;
  const vereditoIntegro = restauracao.ok === true && ehObjeto(restauracao.veredito) && restauracao.veredito.classe === 'INTEGRO' && restauracao.recuperavelEmProducao !== true;
  if (!vereditoIntegro) motivos.push(`RESTAURACAO_${ehObjeto(restauracao.veredito) && typeof restauracao.veredito.classe === 'string' ? restauracao.veredito.classe : 'SEM_VEREDITO'}`);
  if (!plano.rpoAtendido) motivos.push('RPO_FORA_DO_ALVO');
  if (rtoMedidoMs !== null && !rtoAtendido) motivos.push('RTO_FORA_DO_ALVO');
  let classe;
  const indiceDoBanco = PASSOS.findIndex((p) => p.id === 'BANCO');
  const indiceDaFalha = falhouEm === null ? -1 : PASSOS.findIndex((p) => p.id === falhouEm);
  if (completo && vereditoIntegro) classe = plano.rpoAtendido && rtoAtendido ? 'RECUPERADO' : 'RECUPERADO_FORA_DO_ALVO';
  else if ((completo && !vereditoIntegro) || (falhouEm !== null && indiceDaFalha > indiceDoBanco)) classe = 'PARCIAL';
  else classe = 'FALHOU';
  return Object.freeze({ classe, rpoMedidoMs: plano.rpoMedidoMs, rpoAtendido: plano.rpoAtendido, rtoMedidoMs, rtoAtendido, passos: Object.freeze(executados), falhouEm, motivos: Object.freeze(motivos), recuperavelEmProducao: false, restauracaoReal: false });
}

/** Linha NDJSON canônica para o diário/auditoria: só códigos, números e instantes; com SHA-256 da própria linha (sem ele). */
function linhaDeEvidencia(resultado, contexto) {
  if (!ehObjeto(resultado) || !CLASSES.includes(resultado.classe)) throw entradaInvalida('RESULTADO');
  if (!ehObjeto(contexto) || !Reflect.ownKeys(contexto).every((k) => ['conjuntoId', 'sha256Manifesto', 'ensaioEm', 'ambiente'].includes(k))) throw entradaInvalida('CONTEXTO');
  const { conjuntoId, sha256Manifesto, ensaioEm, ambiente } = contexto;
  if (typeof conjuntoId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(conjuntoId) || !/^[0-9a-f]{64}$/.test(sha256Manifesto) || Number.isNaN(instante(ensaioEm)) || !['HOMOLOGACAO', 'ENSAIO_CI', 'PRODUCAO'].includes(ambiente)) throw entradaInvalida('CONTEXTO');
  if (ambiente === 'PRODUCAO') throw entradaInvalida('PRODUCAO_PROIBIDA');
  const corpo = {
    ambiente, classe: resultado.classe, conjuntoId, ensaioEm, falhouEm: resultado.falhouEm, motivos: [...resultado.motivos],
    passos: resultado.passos.map((p) => ({ duracaoMs: p.duracaoMs, id: p.id, ok: p.ok })), recuperavelEmProducao: false, rpoAtendido: resultado.rpoAtendido, rpoMedidoMs: resultado.rpoMedidoMs,
    rtoAtendido: resultado.rtoAtendido, rtoMedidoMs: resultado.rtoMedidoMs, sha256Manifesto, tipo: 'ENSAIO_DR', versao: 1,
  };
  const sha256 = crypto.createHash('sha256').update(JSON.stringify(canonico(corpo))).digest('hex');
  return Object.freeze({ linha: `${JSON.stringify(canonico({ ...corpo, sha256 }))}\n`, sha256 });
}
/** Chaves ordenadas em todos os níveis (um replacer em array omitiria as chaves dos objetos aninhados). */
function canonico(v) { return Array.isArray(v) ? v.map(canonico) : ehObjeto(v) ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, canonico(v[k])])) : v; }

module.exports = { PASSOS, CLASSES, planejarEnsaioDeDR, avaliarEnsaioDeDR, linhaDeEvidencia };
