'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const K = require('../helpers/p4b-caracterizacao');
const S = require('../../src/services/backup-fontes-postgres-sumario.service');

/** D-ORF-6, P4b — o auxiliar de caracterização é puro e testado SEM banco: aqui se prova que ele acusa contradições do mapa v1 e divergências de restauração. */

const ESQ = 'test_migration_abc123';
const CAB = (n) => [`;     TOC Entries: ${n}`, ';     Format: CUSTOM', ';     Dumped from database version: 16.4', ';     Dumped by pg_dump version: 16.4', '; Selected TOC Entries:'].join('\n');
const sumarioDe = (linhas) => S.lerSumario(`${CAB(linhas.length)}\n${linhas.join('\n')}\n`);
const rel = (nome, relkind = 'r', extra = {}) => ({ esquema: ESQ, nome, relkind, sustentaRestricao: false, sequenciaImplicita: false, ...extra });
const inv = (relacoes, migrations = ['000_a', '001_b']) => ({ relacoes, migrations, outros: {}, extensoes: [], servidor: {} });
const RELACOES = [rel('empresas'), rel('vazia'), rel('empresas_id_seq', 'S', { sequenciaImplicita: true }), rel('empresas_pkey', 'i', { sustentaRestricao: true }), rel('idx_cnpj', 'i'), { ...rel('fora'), esquema: 'public' }];
const LINHAS = [
  `1; 1259 1 TABLE ${ESQ} empresas dono`, `2; 0 1 TABLE DATA ${ESQ} empresas dono`, `3; 1259 2 TABLE ${ESQ} vazia dono`,
  `4; 1259 3 SEQUENCE ${ESQ} empresas_id_seq dono`, `5; 0 0 SEQUENCE SET ${ESQ} empresas_id_seq dono`,
  `6; 2606 4 CONSTRAINT ${ESQ} empresas empresas_pkey dono`, `7; 1259 5 INDEX ${ESQ} idx_cnpj dono`, '8; 1259 6 TABLE public fora dono',
];

describe('[KZ] caracterização da observação do P4b', () => {
  test('KZ-01 — observação coerente com o mapa v1: zero contradições; opcionais contadas (TABLE DATA ausente na tabela vazia); só o esquema observado entra', () => {
    const o = K.caracterizarObservacao({ inventario: inv(RELACOES), sumario: sumarioDe(LINHAS), esquema: ESQ });
    assert.deepEqual(o.contradicoes, []);
    assert.equal(o.relacoesDoEsquema, 5);
    assert.deepEqual(o.porCategoria.r, { relacoes: 2, tipos: { TABLE: 2, 'TABLE DATA': 1 }, semEntrada: [] });
    assert.deepEqual(o.porCategoria['i:restricao'], { relacoes: 1, tipos: { CONSTRAINT: 1 }, semEntrada: [] });
    assert.deepEqual(o.opcionais['r:TABLE DATA'], { presentes: 1, ausentes: 1 });
    assert.deepEqual(o.opcionais['S:SEQUENCE OWNED BY'], { presentes: 0, ausentes: 1 });
    assert.equal(o.sumario.declaradasIgualLidas, true);
    assert.equal(o.sumario.versaoServidor, '16.4');
    assert.deepEqual(o.mapa, { versao: 1, observadoEm: null });
    assert.ok(Object.isFrozen(o) && Object.isFrozen(o.porCategoria) && Object.isFrozen(o.contradicoes));
  });

  test('KZ-02 — contradições: obrigatória ausente em alguma relação, tipo não previsto e categoria não mapeada observada', () => {
    const semTabela = K.caracterizarObservacao({ inventario: inv(RELACOES), sumario: sumarioDe(LINHAS.filter((l) => !l.includes('TABLE test_migration_abc123 vazia'))), esquema: ESQ });
    assert.deepEqual(semTabela.contradicoes, ['OBRIGATORIA_NAO_UNIVERSAL:r:TABLE']);
    assert.deepEqual(semTabela.porCategoria.r.semEntrada, ['vazia']);
    const indiceComoConstraint = K.caracterizarObservacao({ inventario: inv(RELACOES), sumario: sumarioDe([...LINHAS, `9; 2606 9 CONSTRAINT ${ESQ} empresas idx_cnpj dono`]), esquema: ESQ });
    assert.deepEqual(indiceComoConstraint.contradicoes, ['TIPO_NAO_PREVISTO:i:CONSTRAINT']);
    const visao = K.caracterizarObservacao({ inventario: inv([...RELACOES, rel('v1', 'v')]), sumario: sumarioDe([...LINHAS, `9; 1259 9 VIEW ${ESQ} v1 dono`]), esquema: ESQ });
    assert.deepEqual(visao.contradicoes, ['CATEGORIA_NAO_MAPEADA_OBSERVADA:v']);
    assert.throws(() => K.caracterizarObservacao({ inventario: inv(RELACOES), sumario: sumarioDe(LINHAS), esquema: 'Inválido' }), TypeError);
    assert.throws(() => K.caracterizarObservacao({ inventario: inv(RELACOES), sumario: sumarioDe(LINHAS) }), TypeError);
  });

  test('KZ-03 — restauração fictícia: tuplas do esquema e migrations idênticas = ok; relação faltante/sobrando ou migrations diferentes = divergência', () => {
    const origem = inv(RELACOES);
    assert.deepEqual(K.compararRestauracao({ origem, restaurado: inv([...RELACOES].reverse()), esquema: ESQ }).ok, true);
    const falta = K.compararRestauracao({ origem, restaurado: inv(RELACOES.slice(1)), esquema: ESQ });
    assert.deepEqual(falta.divergencias, ['RELACOES_FALTAM_NO_RESTAURADO']);
    assert.equal(falta.relacoes.faltamNoRestaurado.length, 1);
    const sobra = K.compararRestauracao({ origem, restaurado: inv([...RELACOES, rel('extra')]), esquema: ESQ });
    assert.deepEqual(sobra.divergencias, ['RELACOES_SOBRAM_NO_RESTAURADO']);
    const atras = K.compararRestauracao({ origem, restaurado: inv(RELACOES, ['000_a']), esquema: ESQ });
    assert.deepEqual(atras.divergencias, ['MIGRATIONS_BANCO_ATRAS_DO_CODIGO']);
    const atributo = K.compararRestauracao({ origem, restaurado: inv(RELACOES.map((r) => (r.nome === 'empresas_pkey' ? { ...r, sustentaRestricao: false } : r))), esquema: ESQ });
    assert.deepEqual(atributo.divergencias, ['RELACOES_FALTAM_NO_RESTAURADO', 'RELACOES_SOBRAM_NO_RESTAURADO']);
    assert.deepEqual(K.compararRestauracao({ origem: inv([]), restaurado: inv([]), esquema: ESQ }).divergencias, ['ESQUEMA_SEM_RELACOES']);
  });

  test('KZ-04 — prova da instância efêmera de CI: mesmas regras do helper J2a; fora do GitHub Actions há motivo de recusa; marcador exige igualdade exata', () => {
    const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', DB_HOST: '127.0.0.1', DB_PORT: '5432', DB_NAME: 'gestao_epi_teste_local', DB_USER: 'postgres', GITHUB_RUN_ID: '41665050995', GITHUB_RUN_ATTEMPT: '1', GEPI_CI_NONCE: 'a'.repeat(32) };
    assert.equal(K.motivoDeRecusaCi(env), null);
    assert.equal(K.marcadorEsperadoCi(env), `GEPI_CI_EFEMERO:41665050995:1:${'a'.repeat(32)}`);
    assert.equal(K.motivoDeRecusaCi({ ...env, PGHOST: 'x' }), 'variável proibida presente: PGHOST');
    assert.equal(K.motivoDeRecusaCi({ ...env, DB_NAME: 'outro' }), 'DB_NAME divergente');
    assert.equal(K.motivoDeRecusaCi({ ...env, GEPI_CI_NONCE: 'curto' }), 'identificadores da execução ausentes ou inválidos');
    assert.notEqual(K.motivoDeRecusaCi(process.env), null, 'esta suíte unitária nunca roda como CI efêmera');
    assert.equal(K.marcadorDoBancoConfere(K.marcadorEsperadoCi(env), K.marcadorEsperadoCi(env)), true);
    assert.equal(K.marcadorDoBancoConfere(null, K.marcadorEsperadoCi(env)), false);
    assert.equal(K.marcadorDoBancoConfere('GEPI_CI_EFEMERO:1:1:x', K.marcadorEsperadoCi(env)), false);
    assert.match(K.SQL_MARCADOR_DO_BANCO, /^SELECT shobj_description/);
  });
});
