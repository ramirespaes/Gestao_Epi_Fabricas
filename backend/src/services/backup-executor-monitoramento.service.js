'use strict';

const { lerLinhaDeEvidencia } = require('./backup-executor-evidencia.service');
const { MODOS, AMBIENTES } = require('./backup-executor-politica.service');

/**
 * D-ORF-6, EXECUTOR OPERACIONAL: MONITORAMENTO. Função pura sobre as linhas de evidência (o modo `--monitorar` do executor só lê um arquivo e chama esta função). Um alerta externo
 * (systemd, cron, CloudWatch) usa o código de saída. NÃO há limiares padrão: RPO e RTO não estão fixados, então quem monitora informa os limites e, sem eles, a avaliação é recusada.
 * Só entram na conta as linhas válidas do MODO e do AMBIENTE monitorados (ensaio não é operação). Linha ilegível ou adulterada é alerta, nunca é ignorada em silêncio.
 * Alertas (códigos fixos): EVIDENCIA_ILEGIVEL, SEM_BACKUP_CONCLUIDO, BACKUP_ATRASADO, RELOGIO_INCONSISTENTE, VERIFICACAO_INDEPENDENTE_AUSENTE, VERIFICACAO_DIVERGENTE, EXECUCAO_INCERTA,
 * FALHAS_CONSECUTIVAS, EXECUCAO_BLOQUEADA e ENSAIO_DE_DR_ATRASADO (este só se o limite for informado).
 */

const MAXIMO_DE_LINHAS = 1000000;
const PENDENCIA_DE_ALVOS = 'RPO_E_RTO_NAO_FIXADOS';

const ehObjeto = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const entradaInvalida = () => Object.assign(new TypeError('entrada do monitoramento inválida'), { code: 'ENTRADA_INVALIDA' });
const positivo = (v) => Number.isSafeInteger(v) && v > 0;
const congelar = (v) => {
  if (v !== null && typeof v === 'object' && !Object.isFrozen(v)) { Object.freeze(v); for (const f of Object.values(v)) congelar(f); }
  return v;
};

function validar(e) {
  if (!ehObjeto(e) || !Reflect.ownKeys(e).every((k) => ['linhas', 'agora', 'modo', 'ambiente', 'limites'].includes(k)) || !Array.isArray(e.linhas) || e.linhas.length > MAXIMO_DE_LINHAS || !e.linhas.every((l) => typeof l === 'string')) throw entradaInvalida();
  if (!Number.isSafeInteger(e.agora) || e.agora < 0 || !MODOS.includes(e.modo) || !AMBIENTES.includes(e.ambiente) || !ehObjeto(e.limites)) throw entradaInvalida();
  const l = e.limites;
  if (!Reflect.ownKeys(l).every((k) => ['backupMs', 'verificacaoMs', 'falhasConsecutivas', 'ensaioDeDrMs'].includes(k)) || !positivo(l.backupMs) || !positivo(l.verificacaoMs)) throw entradaInvalida();
  if (l.falhasConsecutivas !== undefined && !positivo(l.falhasConsecutivas)) throw entradaInvalida();
  if (l.ensaioDeDrMs !== undefined && !positivo(l.ensaioDeDrMs)) throw entradaInvalida();
}

function avaliarMonitoramento(entrada) {
  validar(entrada);
  const { linhas, agora, modo, ambiente, limites } = entrada;
  const falhasPermitidas = limites.falhasConsecutivas === undefined ? 3 : limites.falhasConsecutivas;
  const alertas = [];
  const alertar = (codigo, severidade, extras = {}) => alertas.push({ codigo, severidade, ...extras });

  let lidas = 0;
  let ilegiveis = 0;
  const avaliadas = [];
  for (const texto of linhas) {
    if (texto.length === 0) continue;
    lidas += 1;
    const lida = lerLinhaDeEvidencia(`${texto}\n`);
    if (!lida.ok) { ilegiveis += 1; continue; }
    if (lida.evidencia.modo === modo && lida.evidencia.ambiente === ambiente) avaliadas.push({ ...lida.evidencia, fim: Date.parse(lida.evidencia.concluidoEm) });
  }
  avaliadas.sort((a, b) => a.fim - b.fim);
  if (ilegiveis > 0) alertar('EVIDENCIA_ILEGIVEL', 'CRITICO', { quantidade: ilegiveis });

  const backups = avaliadas.filter((e) => e.acao === 'BACKUP');
  const verificacoes = avaliadas.filter((e) => e.acao === 'VERIFICACAO_DESTINO');
  const ultimoOk = backups.filter((e) => e.estado === 'CONCLUIDO').at(-1);
  let ultimaVerificacaoConforme = null;
  if (ultimoOk === undefined) {
    alertar('SEM_BACKUP_CONCLUIDO', 'CRITICO');
  } else {
    const idade = agora - ultimoOk.fim;
    if (idade < 0) alertar('RELOGIO_INCONSISTENTE', 'CRITICO');
    else if (idade > limites.backupMs) alertar('BACKUP_ATRASADO', 'CRITICO', { idadeMs: idade });
    const doConjunto = verificacoes.filter((v) => v.conjuntoId === ultimoOk.conjuntoId && v.sha256Consolidado === ultimoOk.sha256Consolidado && v.fim >= ultimoOk.fim);
    const conforme = doConjunto.filter((v) => v.estado === 'CONCLUIDO' && v.verificacaoIndependente === 'CONFORME').at(-1);
    ultimaVerificacaoConforme = conforme === undefined ? null : conforme.concluidoEm;
    if (conforme === undefined && idade > limites.verificacaoMs) alertar('VERIFICACAO_INDEPENDENTE_AUSENTE', 'CRITICO');
    if (doConjunto.some((v) => v.estado === 'FALHOU' && v.verificacaoIndependente === 'DIVERGENTE')) alertar('VERIFICACAO_DIVERGENTE', 'CRITICO');
  }
  if (backups.some((e) => e.estado === 'INCERTO' && (ultimoOk === undefined || e.fim > ultimoOk.fim))) alertar('EXECUCAO_INCERTA', 'CRITICO');

  let falhas = 0;
  for (let i = backups.length - 1; i >= 0 && backups[i].estado !== 'CONCLUIDO'; i -= 1) falhas += 1;
  if (falhas >= falhasPermitidas) alertar('FALHAS_CONSECUTIVAS', 'CRITICO', { quantidade: falhas });
  if (backups.length > 0 && backups.at(-1).estado === 'BLOQUEADO') alertar('EXECUCAO_BLOQUEADA', 'AVISO');

  if (limites.ensaioDeDrMs !== undefined) {
    const dr = avaliadas.filter((e) => e.acao === 'RESTAURACAO' && e.estado === 'CONCLUIDO' && !e.comprovacoesPendentes.includes(PENDENCIA_DE_ALVOS)).at(-1);
    if (dr === undefined || agora - dr.fim > limites.ensaioDeDrMs) alertar('ENSAIO_DE_DR_ATRASADO', 'AVISO');
  }

  return congelar({
    veredito: alertas.length === 0 ? 'OK' : 'ALERTA',
    alertas,
    resumo: {
      linhasLidas: lidas, linhasIlegiveis: ilegiveis, avaliadas: avaliadas.length, ultimoBackupConcluidoEm: ultimoOk === undefined ? null : ultimoOk.concluidoEm,
      ultimaVerificacaoConformeEm: ultimaVerificacaoConforme, falhasConsecutivas: falhas,
    },
  });
}

module.exports = { avaliarMonitoramento };
