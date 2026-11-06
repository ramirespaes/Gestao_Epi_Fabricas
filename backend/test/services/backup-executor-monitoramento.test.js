'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const Ev = require('../../src/services/backup-executor-evidencia.service');
const Mon = require('../../src/services/backup-executor-monitoramento.service');

/**
 * D-ORF-6, executor operacional [MON]: avaliador de MONITORAMENTO, puro, sobre as linhas de evidência (um alerta externo — systemd, cron, CloudWatch — chama o modo `--monitorar`
 * do executor). Sem limiares padrão: RPO e RTO não estão fixados, então quem monitora informa os limites e sem eles o avaliador recusa.
 */

const AGORA = Date.UTC(2026, 10, 5, 12, 0, 0);
const MIN = 60000;
const HORA = 60 * MIN;
const LIMITES = { backupMs: 26 * HORA, verificacaoMs: 4 * HORA };

/** Gera uma linha REAL de evidência, concluída `h` horas antes de AGORA. */
function linha({ acao = 'BACKUP', estado = 'CONCLUIDO', h = 1, modo = 'OPERACAO', ambiente = 'HOMOLOGACAO', conjuntoId = 'c1', verificacao, sha = 'a1'.repeat(32) } = {}) {
  const fim = AGORA - h * HORA;
  let primeira = true;
  const relogio = () => { if (primeira) { primeira = false; return fim - 1000; } return fim; };
  const ev = Ev.criarEvidencia({ modo, acao, ambiente, destinoId: 'hml-s3-principal', relogio, operacaoId: 'ab'.repeat(16) });
  const comuns = { conjuntoId, sha256Consolidado: sha, origemDeChaves: 'OPERACIONAL', origemDoDestino: 'OPERACIONAL' };
  const unica = acao === 'VERIFICACAO_DESTINO' ? 'VERIFICAR_DESTINO' : acao === 'BACKUP' ? 'ENVIO' : 'RESTAURAR_FONTES';
  if (estado === 'CONCLUIDO') {
    ev.etapa(unica, true);
    return ev.encerrar({ estado, ...comuns, ...(acao === 'VERIFICACAO_DESTINO' ? { verificacaoIndependente: verificacao ?? 'CONFORME' } : {}) }).linha;
  }
  if (estado === 'BLOQUEADO') return ev.encerrar({ estado, codigo: 'SDK_NAO_APROVADO', falhouEm: 'GATE', bloqueios: ['SDK_NAO_APROVADO'] }).linha;
  ev.etapa(unica, false, 'ENVIO_FALHOU');
  return ev.encerrar({ estado, codigo: 'ENVIO_FALHOU', falhouEm: unica, ...(acao === 'VERIFICACAO_DESTINO' ? { verificacaoIndependente: verificacao ?? 'DIVERGENTE' } : {}), ...comuns }).linha;
}
const avaliar = (linhas, extra = {}) => Mon.avaliarMonitoramento({ linhas: linhas.map((l) => l.replace(/\n$/, '')), agora: AGORA, modo: 'OPERACAO', ambiente: 'HOMOLOGACAO', limites: LIMITES, ...extra });
const codigos = (r) => r.alertas.map((a) => a.codigo);
const lanca = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

describe('[MON] cenários de saúde', () => {
  test('MON-01 — backup recente com verificação independente conforme: sem alertas, com o resumo dos instantes', () => {
    const r = avaliar([linha({ h: 3 }), linha({ acao: 'VERIFICACAO_DESTINO', h: 2 })]);
    assert.deepEqual({ veredito: r.veredito, alertas: r.alertas }, { veredito: 'OK', alertas: [] });
    assert.deepEqual(r.resumo, { linhasLidas: 2, linhasIlegiveis: 0, avaliadas: 2, ultimoBackupConcluidoEm: new Date(AGORA - 3 * HORA).toISOString(), ultimaVerificacaoConformeEm: new Date(AGORA - 2 * HORA).toISOString(), falhasConsecutivas: 0 });
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.alertas));
  });

  test('MON-02 — nenhum backup concluído (arquivo vazio, só falhas ou só bloqueios): SEM_BACKUP_CONCLUIDO', () => {
    assert.deepEqual(codigos(avaliar([])), ['SEM_BACKUP_CONCLUIDO']);
    assert.ok(codigos(avaliar([linha({ estado: 'FALHOU' })])).includes('SEM_BACKUP_CONCLUIDO'));
    assert.deepEqual(codigos(avaliar([linha({ estado: 'BLOQUEADO' })])), ['SEM_BACKUP_CONCLUIDO', 'EXECUCAO_BLOQUEADA']);
  });

  test('MON-03 — backup atrasado: exatamente no limite ainda está bem; um milissegundo além alerta (CRITICO, com a idade)', () => {
    const noLimite = avaliar([linha({ h: 26 }), linha({ acao: 'VERIFICACAO_DESTINO', h: 25 })]);
    assert.deepEqual(codigos(noLimite), []);
    const alem = avaliar([linha({ h: 26 })], { agora: AGORA + 1 });
    assert.ok(codigos(alem).includes('BACKUP_ATRASADO'));
    assert.deepEqual(alem.alertas.find((a) => a.codigo === 'BACKUP_ATRASADO'), { codigo: 'BACKUP_ATRASADO', severidade: 'CRITICO', idadeMs: 26 * HORA + 1 });
  });
});

describe('[MON] verificação independente', () => {
  test('MON-04 — sem verificação conforme DO MESMO conjunto e do mesmo consolidado, passada a janela: VERIFICACAO_INDEPENDENTE_AUSENTE; dentro da janela, ainda não alerta', () => {
    assert.deepEqual(codigos(avaliar([linha({ h: 5 })])), ['VERIFICACAO_INDEPENDENTE_AUSENTE']);
    assert.deepEqual(codigos(avaliar([linha({ h: 3 })])), []);
    assert.deepEqual(codigos(avaliar([linha({ h: 5 }), linha({ acao: 'VERIFICACAO_DESTINO', h: 4, conjuntoId: 'outro' })])), ['VERIFICACAO_INDEPENDENTE_AUSENTE']);
    assert.deepEqual(codigos(avaliar([linha({ h: 5 }), linha({ acao: 'VERIFICACAO_DESTINO', h: 4, sha: 'b2'.repeat(32) })])), ['VERIFICACAO_INDEPENDENTE_AUSENTE']);
    assert.deepEqual(codigos(avaliar([linha({ h: 5 }), linha({ acao: 'VERIFICACAO_DESTINO', h: 4 })])), []);
  });

  test('MON-05 — verificação divergente depois do último backup: VERIFICACAO_DIVERGENTE (CRITICO); a divergência anterior ao backup não conta', () => {
    const r = avaliar([linha({ h: 6 }), linha({ acao: 'VERIFICACAO_DESTINO', estado: 'FALHOU', h: 5 })]);
    assert.ok(codigos(r).includes('VERIFICACAO_DIVERGENTE'));
    const antiga = avaliar([linha({ acao: 'VERIFICACAO_DESTINO', estado: 'FALHOU', h: 7 }), linha({ h: 6 }), linha({ acao: 'VERIFICACAO_DESTINO', h: 5 })]);
    assert.deepEqual(codigos(antiga), []);
  });
});

describe('[MON] execuções incertas e falhas', () => {
  test('MON-06 — execução INCERTA depois do último backup concluído pede decisão humana (EXECUCAO_INCERTA); resolvida por backup posterior, não alerta', () => {
    assert.ok(codigos(avaliar([linha({ h: 6 }), linha({ estado: 'INCERTO', h: 3 }), linha({ acao: 'VERIFICACAO_DESTINO', h: 5 })])).includes('EXECUCAO_INCERTA'));
    const resolvida = avaliar([linha({ estado: 'INCERTO', h: 7 }), linha({ h: 3 }), linha({ acao: 'VERIFICACAO_DESTINO', h: 2 })]);
    assert.deepEqual(codigos(resolvida), []);
  });

  test('MON-07 — falhas consecutivas do backup (padrão 3, configurável); um sucesso no meio zera a contagem; recusas e incertos também contam como não concluídos', () => {
    const tres = avaliar([linha({ h: 30 }), linha({ estado: 'FALHOU', h: 3 }), linha({ estado: 'RECUSADO', h: 2 }), linha({ estado: 'FALHOU', h: 1 })], { agora: AGORA });
    assert.ok(codigos(tres).includes('FALHAS_CONSECUTIVAS'));
    assert.equal(tres.resumo.falhasConsecutivas, 3);
    const quebrada = avaliar([linha({ estado: 'FALHOU', h: 4 }), linha({ h: 3 }), linha({ acao: 'VERIFICACAO_DESTINO', h: 2 }), linha({ estado: 'FALHOU', h: 1 })]);
    assert.equal(quebrada.resumo.falhasConsecutivas, 1);
    assert.equal(codigos(quebrada).includes('FALHAS_CONSECUTIVAS'), false);
    const dois = avaliar([linha({ h: 30 }), linha({ estado: 'FALHOU', h: 2 }), linha({ estado: 'FALHOU', h: 1 })], { limites: { ...LIMITES, falhasConsecutivas: 2 } });
    assert.ok(codigos(dois).includes('FALHAS_CONSECUTIVAS'));
  });
});

describe('[MON] linhas, filtros e entrada', () => {
  test('MON-08 — linha adulterada ou ilegível: EVIDENCIA_ILEGIVEL com a contagem; as válidas continuam sendo avaliadas', () => {
    const boa = linha({ h: 3 });
    const adulterada = boa.replace('"modo":"OPERACAO"', '"modo":"ENSAIO"').replace(/\n$/, '');
    assert.notEqual(adulterada, boa.replace(/\n$/, ''));
    const r = avaliar([linha({ h: 3 }), linha({ acao: 'VERIFICACAO_DESTINO', h: 2 })], {});
    assert.equal(r.veredito, 'OK');
    const comRuido = Mon.avaliarMonitoramento({ linhas: [boa.replace(/\n$/, ''), 'não é json', adulterada, '', linha({ acao: 'VERIFICACAO_DESTINO', h: 2 }).replace(/\n$/, '')], agora: AGORA, modo: 'OPERACAO', ambiente: 'HOMOLOGACAO', limites: LIMITES });
    assert.deepEqual(codigos(comRuido), ['EVIDENCIA_ILEGIVEL']);
    assert.deepEqual({ lidas: comRuido.resumo.linhasLidas, ilegiveis: comRuido.resumo.linhasIlegiveis, avaliadas: comRuido.resumo.avaliadas }, { lidas: 4, ilegiveis: 2, avaliadas: 2 });
    assert.equal(comRuido.alertas[0].quantidade, 2);
  });

  test('MON-09 — só entra na avaliação o modo e o ambiente monitorados (ensaio não é operação; HML não é PROD)', () => {
    const r = avaliar([linha({ h: 3, modo: 'ENSAIO' }), linha({ h: 3, ambiente: 'PRODUCAO' })]);
    assert.deepEqual({ cod: codigos(r), avaliadas: r.resumo.avaliadas }, { cod: ['SEM_BACKUP_CONCLUIDO'], avaliadas: 0 });
    const ensaio = avaliar([linha({ h: 3, modo: 'ENSAIO' }), linha({ acao: 'VERIFICACAO_DESTINO', h: 2, modo: 'ENSAIO' })], { modo: 'ENSAIO' });
    assert.deepEqual(codigos(ensaio), []);
  });

  test('MON-10 — evidência com data no futuro (relógio inconsistente) alerta em vez de parecer recente; ensaio de DR atrasado só alerta se o limite for informado', () => {
    const futuro = avaliar([linha({ h: -2 }), linha({ acao: 'VERIFICACAO_DESTINO', h: -1 })]);
    assert.ok(codigos(futuro).includes('RELOGIO_INCONSISTENTE'));
    const base = [linha({ h: 3 }), linha({ acao: 'VERIFICACAO_DESTINO', h: 2 })];
    assert.deepEqual(codigos(avaliar(base)), []);
    assert.deepEqual(codigos(avaliar(base, { limites: { ...LIMITES, ensaioDeDrMs: 30 * 24 * HORA } })), ['ENSAIO_DE_DR_ATRASADO']);
    const comDr = [...base, linha({ acao: 'RESTAURACAO', h: 24 })];
    assert.deepEqual(codigos(avaliar(comDr, { limites: { ...LIMITES, ensaioDeDrMs: 30 * 24 * HORA } })), []);
    assert.deepEqual(codigos(avaliar(comDr, { limites: { ...LIMITES, ensaioDeDrMs: 12 * HORA } })), ['ENSAIO_DE_DR_ATRASADO']);
  });

  test('MON-11 — entrada fora do contrato é erro de programação: sem limites (RPO/RTO não fixados), limites inválidos, modo/ambiente desconhecidos, linhas que não são texto, agora inválido', () => {
    const base = { linhas: [], agora: AGORA, modo: 'OPERACAO', ambiente: 'HOMOLOGACAO', limites: LIMITES };
    for (const ruim of [undefined, { ...base, limites: undefined }, { ...base, limites: {} }, { ...base, limites: { backupMs: 0, verificacaoMs: 1 } }, { ...base, limites: { backupMs: 1, verificacaoMs: -1 } }, { ...base, limites: { ...LIMITES, falhasConsecutivas: 0 } },
      { ...base, limites: { ...LIMITES, extra: 1 } }, { ...base, modo: 'X' }, { ...base, ambiente: 'DEV' }, { ...base, linhas: [5] }, { ...base, linhas: 'texto' }, { ...base, agora: 'ontem' }, { ...base, extra: 1 }]) {
      assert.equal(lanca(() => Mon.avaliarMonitoramento(ruim)), 'ENTRADA_INVALIDA', JSON.stringify(ruim)?.slice(0, 60));
    }
  });
});
