'use strict';

const { lerLinhaDeEvidencia } = require('./backup-executor-evidencia.service');

/**
 * D-ORF-6, L1 (Bloco A), D-F13: AUDITORIA do executor reaproveitando a trilha existente (`logs_auditoria_plataforma`, via `registrarEventoSistema`; sem migration, sem arquivo novo).
 * O registro primário continua sendo a linha de evidência no stdout do CLI; aqui sai UM evento por execução, derivado dessa mesma linha.
 *
 * `criarAuditoriaDoExecutor({ executorDeBanco, registrarEventoSistema })` -> `{ registrar({ linha }) }`. A linha é relida e conferida por `lerLinhaDeEvidencia` (forma e hash); o evento leva só um
 * subconjunto não sensível (identificadores, estado, códigos, contagens e o hash da evidência). `registrar` nunca lança: devolve `{ gravado: true, id }` ou `{ gravado: false, codigo }` com código fixo,
 * de modo que falha de auditoria não mascara o desfecho da execução (que já está na evidência).
 */

const CAMPOS_DO_CONTEXTO = Object.freeze(['operacaoId', 'tipo', 'modo', 'ambiente', 'destinoId', 'estado', 'codigo', 'falhouEm', 'duracaoMs', 'conjuntoId', 'arquivos', 'bytes', 'operacional', 'verificacaoIndependente', 'sha256']);
const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const configuracaoInvalida = () => Object.assign(new TypeError('configuração da auditoria do executor inválida'), { code: 'AUDITORIA_CONFIGURACAO_INVALIDA' });

function eventoDaEvidencia(evidencia) {
  const contexto = {};
  for (const campo of CAMPOS_DO_CONTEXTO) if (evidencia[campo] !== undefined && evidencia[campo] !== null) contexto[campo] = evidencia[campo];
  return {
    acao: `BACKUP_EXECUTOR_${evidencia.acao}_${evidencia.estado}`,
    referencia: evidencia.operacaoId,
    descricao: `Execução ${evidencia.acao} ${evidencia.estado}`,
    contexto,
  };
}

function criarAuditoriaDoExecutor(opcoes) {
  if (!ehObjeto(opcoes) || !Reflect.ownKeys(opcoes).every((k) => ['executorDeBanco', 'registrarEventoSistema'].includes(k))) throw configuracaoInvalida();
  const { executorDeBanco, registrarEventoSistema } = opcoes;
  if (!ehObjeto(executorDeBanco) || typeof executorDeBanco.query !== 'function' || typeof registrarEventoSistema !== 'function') throw configuracaoInvalida();

  async function registrar(entrada) {
    if (!ehObjeto(entrada) || !Reflect.ownKeys(entrada).every((k) => k === 'linha')) return Object.freeze({ gravado: false, codigo: 'AUDITORIA_ENTRADA_INVALIDA' });
    const lida = lerLinhaDeEvidencia(entrada.linha);
    if (!lida.ok) return Object.freeze({ gravado: false, codigo: 'AUDITORIA_EVIDENCIA_INVALIDA' });
    try {
      const { id } = await registrarEventoSistema(executorDeBanco, eventoDaEvidencia(lida.evidencia));
      return Object.freeze({ gravado: true, id });
    } catch {
      return Object.freeze({ gravado: false, codigo: 'AUDITORIA_NAO_GRAVADA' });
    }
  }

  return Object.freeze({ registrar });
}

module.exports = { criarAuditoriaDoExecutor, eventoDaEvidencia, CAMPOS_DO_CONTEXTO };
