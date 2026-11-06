'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('../../src/services/backup-executor-evidencia.service');
const { COMPROVACOES_POSTERIORES } = require('../../src/services/backup-armazenamento-duravel-fichas.service');

/**
 * D-ORF-6, executor operacional [EVI]: a EVIDÊNCIA de cada execução — uma linha NDJSON canônica com SHA-256 próprio, só códigos, números, instantes e identificadores de formato
 * fixo (nunca caminho, texto livre ou segredo). O executor nunca declara "durável" nem "recuperável em produção"; `operacional` só é verdadeiro na operação real concluída com
 * chaves e destino OPERACIONAIS (que hoje não existe).
 */

const ID = 'ab'.repeat(16);
const H1 = 'c1'.repeat(32);
const H2 = 'd2'.repeat(32);
const relogioDe = (inicio = Date.UTC(2026, 10, 5, 12, 0, 0), passo = 10) => { let t = inicio - passo; return () => { t += passo; return t; }; };
const novo = (extra = {}) => E.criarEvidencia({ modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', relogio: relogioDe(), operacaoId: ID, ...extra });
const ETAPAS_BACKUP = ['COORDENACAO', 'PRODUCAO', 'DESTINO_LOCAL', 'CIFRA', 'INVENTARIO', 'PRE_VOO', 'ENVIO', 'CONSOLIDACAO', 'CONFIRMACAO', 'VERIFICACAO', 'REGISTRO_DOS_RECIBOS'];
const sucesso = (ev, extra = {}) => ev.encerrar({ estado: 'CONCLUIDO', conjuntoId: 'c1', sha256Manifesto: H1, sha256Consolidado: H2, arquivos: 3, bytes: 1234, origemDeChaves: 'TESTE_CONTROLADO', origemDoDestino: 'TESTE_CONTROLADO', verificacaoIndependente: 'CONFORME', ...extra });
const codigo = (fn) => { try { fn(); } catch (e) { return e.code; } return null; };

describe('[EVI] registro e linha', () => {
  test('EVI-01 — execução concluída: campos fechados e ordenados, instantes e durações do relógio injetado, pendências de prova sempre presentes, nada de "durável" nem "recuperável"', () => {
    const ev = novo();
    for (const id of ETAPAS_BACKUP) ev.etapa(id, true);
    const r = sucesso(ev);
    const e = r.evidencia;
    assert.deepEqual(Object.keys(e), Object.keys(e).slice().sort(), 'chaves em ordem canônica');
    assert.deepEqual({ tipo: e.tipo, versao: e.versao, operacaoId: e.operacaoId, modo: e.modo, acao: e.acao, ambiente: e.ambiente, estado: e.estado, codigo: e.codigo, falhouEm: e.falhouEm, bloqueios: e.bloqueios },
      { tipo: 'EXECUCAO_BACKUP', versao: 1, operacaoId: ID, modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO', estado: 'CONCLUIDO', codigo: null, falhouEm: null, bloqueios: [] });
    assert.deepEqual({ ini: e.iniciadoEm, fim: e.concluidoEm, dur: e.duracaoMs }, { ini: '2026-11-05T12:00:00.000Z', fim: '2026-11-05T12:00:00.120Z', dur: 120 });
    assert.deepEqual(e.etapas.map((x) => x.id), ETAPAS_BACKUP);
    assert.ok(e.etapas.every((x) => x.ok === true && x.codigo === null && Number.isInteger(x.duracaoMs) && x.duracaoMs >= 0));
    assert.deepEqual(e.comprovacoesPendentes, [...COMPROVACOES_POSTERIORES]);
    assert.deepEqual({ d: e.duravelmenteArmazenado, o: e.operacional, p: e.recuperavelEmProducao }, { d: false, o: false, p: false });
    assert.deepEqual({ c: e.conjuntoId, m: e.sha256Manifesto, k: e.sha256Consolidado, a: e.arquivos, b: e.bytes, d: e.destinoId, v: e.verificacaoIndependente }, { c: 'c1', m: H1, k: H2, a: 3, b: 1234, d: 'hml-s3-principal', v: 'CONFORME' });
    assert.ok(r.linha.endsWith('\n') && !r.linha.slice(0, -1).includes('\n'));
    assert.equal(JSON.parse(r.linha).sha256, r.sha256);
    assert.ok(Object.isFrozen(e) && Object.isFrozen(e.etapas) && Object.isFrozen(r));
  });

  test('EVI-02 — a duração de cada etapa é medida a partir do marco anterior (a primeira, do início); falha registra a etapa, o código fixo e para de aceitar etapas', () => {
    const ev = novo();
    ev.etapa('PRODUCAO', true);
    ev.etapa('DESTINO_LOCAL', true);
    ev.etapa('CIFRA', false, 'CIFRA_FALHOU');
    const e = ev.encerrar({ estado: 'FALHOU', codigo: 'CIFRA_FALHOU', falhouEm: 'CIFRA' }).evidencia;
    assert.deepEqual(e.etapas.map((x) => [x.id, x.ok, x.codigo, x.duracaoMs]), [['PRODUCAO', true, null, 10], ['DESTINO_LOCAL', true, null, 10], ['CIFRA', false, 'CIFRA_FALHOU', 10]]);
    assert.deepEqual({ estado: e.estado, codigo: e.codigo, falhouEm: e.falhouEm, ver: e.verificacaoIndependente, sha: e.sha256Manifesto, arq: e.arquivos }, { estado: 'FALHOU', codigo: 'CIFRA_FALHOU', falhouEm: 'CIFRA', ver: 'NAO_APLICA', sha: null, arq: null });
    assert.equal(codigo(() => ev.etapa('INVENTARIO', true)), 'EVIDENCIA_ENCERRADA');
  });

  test('EVI-03 — combinações incoerentes são recusadas: concluído com código ou etapa falha; falha sem código ou com etapa inexistente; etapa repetida ou fora da ação; estado desconhecido', () => {
    const c = (fn) => codigo(fn);
    assert.equal(c(() => { const ev = novo(); ev.etapa('PRODUCAO', true); sucesso(ev, { codigo: 'ALGO' }); }), 'EVIDENCIA_INVALIDA');
    assert.equal(c(() => { const ev = novo(); ev.etapa('PRODUCAO', false, 'X_Y_Z'); sucesso(ev); }), 'EVIDENCIA_INVALIDA');
    assert.equal(c(() => novo().encerrar({ estado: 'FALHOU', falhouEm: 'CIFRA' })), 'EVIDENCIA_INVALIDA');
    assert.equal(c(() => novo().encerrar({ estado: 'FALHOU', codigo: 'CIFRA_FALHOU', falhouEm: 'CIFRA' })), 'EVIDENCIA_INVALIDA', 'falhou em etapa que não foi registrada');
    assert.equal(c(() => { const ev = novo(); ev.etapa('PRODUCAO', true); ev.etapa('PRODUCAO', true); }), 'EVIDENCIA_INVALIDA');
    assert.equal(c(() => novo().etapa('DECIFRAR', true)), 'EVIDENCIA_INVALIDA');
    assert.equal(c(() => novo().etapa('PRODUCAO', 'sim')), 'EVIDENCIA_INVALIDA');
    assert.equal(c(() => novo().encerrar({ estado: 'TALVEZ' })), 'EVIDENCIA_INVALIDA');
    assert.equal(c(() => novo().encerrar({ estado: 'FALHOU', codigo: 'Erro: senha=123', falhouEm: 'GATE' })), 'EVIDENCIA_INVALIDA');
  });

  test('EVI-04 — bloqueio: exige a lista de bloqueios conhecidos (e falhouEm GATE); código vem do primeiro bloqueio; bloqueio desconhecido ou lista vazia é recusado', () => {
    const e = novo().encerrar({ estado: 'BLOQUEADO', codigo: 'SDK_NAO_APROVADO', falhouEm: 'GATE', bloqueios: ['DESTINO_DURAVEL_NAO_APROVADO', 'SDK_NAO_APROVADO'] }).evidencia;
    assert.deepEqual({ estado: e.estado, codigo: e.codigo, falhouEm: e.falhouEm, bloqueios: e.bloqueios, etapas: e.etapas }, { estado: 'BLOQUEADO', codigo: 'SDK_NAO_APROVADO', falhouEm: 'GATE', bloqueios: ['DESTINO_DURAVEL_NAO_APROVADO', 'SDK_NAO_APROVADO'], etapas: [] });
    assert.equal(codigo(() => novo().encerrar({ estado: 'BLOQUEADO', codigo: 'X_Y_Z', falhouEm: 'GATE', bloqueios: [] })), 'EVIDENCIA_INVALIDA');
    assert.equal(codigo(() => novo().encerrar({ estado: 'BLOQUEADO', codigo: 'SDK_NAO_APROVADO', falhouEm: 'GATE', bloqueios: ['INVENTADO_AGORA'] })), 'EVIDENCIA_INVALIDA');
    assert.equal(codigo(() => novo().encerrar({ estado: 'FALHOU', codigo: 'CIFRA_FALHOU', falhouEm: 'GATE', bloqueios: ['SDK_NAO_APROVADO'] })), 'EVIDENCIA_INVALIDA', 'só o estado BLOQUEADO traz bloqueios');
  });

  test('EVI-05 — nenhum texto livre: identificadores, hashes, números e enumerações fora do formato são recusados (caminho, URL, espaço, segredo, número negativo ou fracionário)', () => {
    const tentar = (extra) => codigo(() => { const ev = novo(); ev.etapa('PRODUCAO', true); sucesso(ev, extra); });
    for (const ruim of [{ conjuntoId: '/etc/passwd' }, { conjuntoId: 'a b' }, { conjuntoId: 'x'.repeat(201) }, { sha256Manifesto: 'abc' }, { sha256Consolidado: H1.toUpperCase() }, { arquivos: -1 }, { arquivos: 1.5 }, { bytes: '10' },
      { origemDeChaves: 'cofre-do-ramires' }, { origemDoDestino: 'bucket-real' }, { verificacaoIndependente: 'talvez' }, { comprovacoesPendentes: ['texto livre com espaço'] }, { comprovacoesPendentes: 'T2' }, { extra: 1 }]) {
      assert.equal(tentar(ruim), 'EVIDENCIA_INVALIDA', JSON.stringify(ruim));
    }
    for (const ruim of [{ modo: 'x' }, { acao: 'LIMPEZA' }, { ambiente: 'DEV' }, { destinoId: 'https://x' }, { operacaoId: 'g'.repeat(32) }, { relogio: 5 }]) {
      assert.equal(codigo(() => novo(ruim)), 'EVIDENCIA_INVALIDA', JSON.stringify(ruim));
    }
  });

  test('EVI-06 — "operacional" só é verdadeiro na OPERAÇÃO concluída com chaves E destino operacionais; no ensaio nunca, mesmo com origens operacionais; o chamador não consegue forçar o campo', () => {
    const op = (modo, estado, chaves, destino) => {
      const ev = novo({ modo });
      if (estado === 'CONCLUIDO') {
        for (const id of ETAPAS_BACKUP) ev.etapa(id, true);
        return ev.encerrar({ estado, origemDeChaves: chaves, origemDoDestino: destino, verificacaoIndependente: 'CONFORME' }).evidencia.operacional;
      }
      for (const id of ETAPAS_BACKUP.slice(0, 5)) ev.etapa(id, true);
      ev.etapa('ENVIO', false, 'ENVIO_FALHOU');
      return ev.encerrar({ estado, codigo: 'ENVIO_FALHOU', falhouEm: 'ENVIO', origemDeChaves: chaves, origemDoDestino: destino }).evidencia.operacional;
    };
    assert.equal(op('OPERACAO', 'CONCLUIDO', 'OPERACIONAL', 'OPERACIONAL'), true);
    assert.equal(op('OPERACAO', 'CONCLUIDO', 'TESTE_CONTROLADO', 'OPERACIONAL'), false);
    assert.equal(op('OPERACAO', 'CONCLUIDO', 'OPERACIONAL', 'TESTE_CONTROLADO'), false);
    assert.equal(op('OPERACAO', 'CONCLUIDO', null, null), false);
    assert.equal(op('ENSAIO', 'CONCLUIDO', 'OPERACIONAL', 'OPERACIONAL'), false);
    assert.equal(op('OPERACAO', 'FALHOU', 'OPERACIONAL', 'OPERACIONAL'), false);
    assert.equal(codigo(() => { const ev = novo(); ev.etapa('PRODUCAO', true); sucesso(ev, { operacional: true }); }), 'EVIDENCIA_INVALIDA');
    assert.equal(codigo(() => { const ev = novo(); ev.etapa('PRODUCAO', true); sucesso(ev, { duravelmenteArmazenado: true }); }), 'EVIDENCIA_INVALIDA');
  });

  test('EVI-07 — as ações têm conjuntos de etapas próprios (backup, restauração e verificação do destino) e os tipos de evidência correspondentes', () => {
    assert.deepEqual([...E.ETAPAS.BACKUP], ETAPAS_BACKUP);
    assert.deepEqual([...E.ETAPAS.RESTAURACAO], ['COORDENACAO', 'DESTINO_LOCAL', 'RESTAURAR_CONTAINER', 'VERIFICAR_PACOTE', 'RESTAURAR_FONTES', 'AVALIAR_DR']);
    assert.deepEqual([...E.ETAPAS.VERIFICACAO_DESTINO], ['VERIFICAR_DESTINO']);
    const ev = novo({ acao: 'VERIFICACAO_DESTINO' });
    ev.etapa('VERIFICAR_DESTINO', true);
    assert.equal(ev.encerrar({ estado: 'CONCLUIDO', conjuntoId: 'c1', verificacaoIndependente: 'CONFORME' }).evidencia.tipo, 'EXECUCAO_VERIFICACAO_DESTINO');
    assert.equal(novo({ acao: 'RESTAURACAO' }).encerrar({ estado: 'BLOQUEADO', codigo: 'SDK_NAO_APROVADO', falhouEm: 'GATE', bloqueios: ['SDK_NAO_APROVADO'] }).evidencia.tipo, 'EXECUCAO_RESTAURACAO');
  });

  test('EVI-08 — determinística: mesmos dados, mesma linha e mesmo SHA-256; qualquer campo diferente muda o SHA-256; o identificador da operação é aleatório quando não informado', () => {
    const a = (() => { const ev = novo(); ev.etapa('PRODUCAO', true); return sucesso(ev); })();
    const b = (() => { const ev = novo(); ev.etapa('PRODUCAO', true); return sucesso(ev); })();
    assert.equal(a.linha, b.linha);
    const c = (() => { const ev = novo(); ev.etapa('PRODUCAO', true); return sucesso(ev, { bytes: 1235 }); })();
    assert.notEqual(a.sha256, c.sha256);
    const x = E.criarEvidencia({ modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', relogio: relogioDe() }).encerrar({ estado: 'BLOQUEADO', codigo: 'SDK_NAO_APROVADO', falhouEm: 'GATE', bloqueios: ['SDK_NAO_APROVADO'] }).evidencia.operacaoId;
    const y = E.criarEvidencia({ modo: 'ENSAIO', acao: 'BACKUP', ambiente: 'HOMOLOGACAO', destinoId: 'hml-s3-principal', relogio: relogioDe() }).encerrar({ estado: 'BLOQUEADO', codigo: 'SDK_NAO_APROVADO', falhouEm: 'GATE', bloqueios: ['SDK_NAO_APROVADO'] }).evidencia.operacaoId;
    assert.match(x, /^[0-9a-f]{32}$/);
    assert.notEqual(x, y);
  });
});

describe('[EVI] leitura da linha (monitoramento)', () => {
  const linhaOk = () => { const ev = novo(); ev.etapa('PRODUCAO', true); return sucesso(ev).linha; };

  test('EVI-09 — a linha escrita é lida de volta idêntica (ida e volta); o SHA-256 é conferido', () => {
    const linha = linhaOk();
    const r = E.lerLinhaDeEvidencia(linha);
    assert.equal(r.ok, true);
    assert.equal(`${JSON.stringify(r.evidencia)}\n`, linha);
  });

  test('EVI-10 — linha adulterada, sem hash, com campo extra, sem quebra de linha, grande demais ou que não é JSON: recusada com motivo fixo', () => {
    const linha = linhaOk();
    const objeto = JSON.parse(linha);
    const r = (texto) => E.lerLinhaDeEvidencia(texto);
    assert.deepEqual(r(linha.replace('"bytes":1234', '"bytes":1235')), { ok: false, motivo: 'HASH_DIVERGENTE' });
    assert.deepEqual(r(`${JSON.stringify({ ...objeto, extra: 1 })}\n`), { ok: false, motivo: 'FORMA_INVALIDA' });
    const { sha256: _omitido, ...semHash } = objeto;
    assert.deepEqual(r(`${JSON.stringify(semHash)}\n`), { ok: false, motivo: 'FORMA_INVALIDA' });
    assert.deepEqual(r(linha.slice(0, -1)), { ok: false, motivo: 'FORMA_INVALIDA' });
    assert.deepEqual(r(`${'x'.repeat(70000)}\n`), { ok: false, motivo: 'LINHA_GRANDE' });
    assert.deepEqual(r('não é json\n'), { ok: false, motivo: 'JSON_INVALIDO' });
    assert.deepEqual(r(5), { ok: false, motivo: 'FORMA_INVALIDA' });
    assert.deepEqual(r(`${JSON.stringify({ ...objeto, estado: 'TALVEZ' })}\n`), { ok: false, motivo: 'FORMA_INVALIDA' });
  });
});
