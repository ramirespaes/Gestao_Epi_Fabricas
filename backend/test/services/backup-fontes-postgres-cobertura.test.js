'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const C = require('../../src/services/backup-fontes-postgres-cobertura.service');
const S = require('../../src/services/backup-fontes-postgres-sumario.service');
const R = require('../../src/services/backup-fontes-regras.service');
const { obterCatalogo } = require('../../src/services/backup-fontes-catalogo.service');

/**
 * D-ORF-6, P4a — CONTRATO `cobertura.postgres`: comparador inventário × sumário (mapa explícito v1, [NV] até o P4b), impressão digital e
 * compatibilidade das migrations, dependências externas declaradas e o bloco com nível. Tudo puro, com texto sintético; nenhum banco.
 */

const CABECALHO = (n) => [';     TOC Entries: ' + n, ';     Format: CUSTOM', ';     Dumped from database version: 16.4', '; Selected TOC Entries:'].join('\n');
const sumarioDe = (linhas) => S.lerSumario(`${CABECALHO(linhas.length)}\n${linhas.join('\n')}\n`);

const rel = (nome, relkind = 'r', extra = {}) => ({ esquema: 'public', nome, relkind, sustentaRestricao: false, sequenciaImplicita: false, ...extra });
const MIGRATIONS = ['000_create_function_set_atualizado_em', '001_create_empresas', '002_create_perfis'];
const inventarioBase = (extra = {}) => ({
  relacoes: [rel('empresas'), rel('empresas_id_seq', 'S', { sequenciaImplicita: true }), rel('empresas_pkey', 'i', { sustentaRestricao: true }), rel('idx_empresas_cnpj', 'i')],
  outros: { FUNCTION: 1, TRIGGER: 1, TYPE: 0, EXTENSION: 0, RULE: 0, POLICY: 0, PUBLICATION: 0, 'EVENT TRIGGER': 0, SCHEMA: 0 },
  extensoes: [{ nome: 'plpgsql', versao: '1.0' }],
  servidor: { versao: '16.4', encoding: 'UTF8', collate: 'C', ctype: 'C' },
  migrations: MIGRATIONS,
  ...extra,
});
const LINHAS_COMPLETAS = [
  '1; 0 0 ENCODING - ENCODING',
  '215; 1259 16400 TABLE public empresas dono',
  '3400; 0 16400 TABLE DATA public empresas dono',
  '216; 1259 16410 SEQUENCE public empresas_id_seq dono',
  '3401; 0 0 SEQUENCE SET public empresas_id_seq dono',
  '3600; 2606 16500 CONSTRAINT public empresas empresas_pkey dono',
  '3601; 1259 16501 INDEX public idx_empresas_cnpj dono',
  '3800; 2620 16700 TRIGGER public empresas trg dono',
  '220; 1255 16800 FUNCTION public set_atualizado_em() dono',
];
const sem = (trecho) => LINHAS_COMPLETAS.filter((l) => !l.includes(trecho));

describe('[CB] comparador inventário × sumário', () => {
  test('CB-01 — sumário completo: toda relação do inventário tem as entradas obrigatórias do mapa; opcionais contadas; ok=true; saída congelada', () => {
    const r = C.compararInventarioComSumario({ inventario: inventarioBase(), sumario: sumarioDe(LINHAS_COMPLETAS) });
    assert.equal(r.ok, true, JSON.stringify(r.motivos));
    assert.deepEqual(r.relacoes.ausentes, []);
    assert.deepEqual(r.relacoes.categoriasNaoMapeadas, []);
    assert.equal(r.relacoes.inventariadas, 4);
    assert.equal(r.relacoes.correspondidas, 4);
    assert.equal(r.relacoes.entradasSemInventario, 0);
    assert.deepEqual(r.relacoes.opcionaisAusentes, { 'SEQUENCE OWNED BY': 1 });
    assert.match(r.relacoes.sha256, /^[0-9a-f]{64}$/);
    assert.deepEqual(r.mapa, { versao: 1, observado: true });
    assert.equal(r.sumario.entradas, 9);
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.relacoes) && Object.isFrozen(r.relacoes.ausentes));
  });

  test('CB-02 — relação do inventário sem entrada obrigatória = RELACAO_AUSENTE_NO_DUMP (tabela, sequência, índice e índice de restrição, cada um)', () => {
    const casos = [['TABLE public empresas', 'public.empresas:TABLE'], ['SEQUENCE public', 'public.empresas_id_seq:SEQUENCE'], ['INDEX public', 'public.idx_empresas_cnpj:INDEX'], ['CONSTRAINT public', 'public.empresas_pkey:CONSTRAINT']];
    for (const [trecho, esperado] of casos) {
      const r = C.compararInventarioComSumario({ inventario: inventarioBase(), sumario: sumarioDe(sem(trecho)) });
      assert.equal(r.ok, false, trecho);
      assert.deepEqual(r.motivos, ['RELACAO_AUSENTE_NO_DUMP'], trecho);
      assert.deepEqual(r.relacoes.ausentes, [esperado], trecho);
      assert.equal(r.relacoes.correspondidas, 3);
    }
    const semDados = C.compararInventarioComSumario({ inventario: inventarioBase(), sumario: sumarioDe(sem('TABLE DATA')) });
    assert.equal(semDados.ok, true, 'TABLE DATA é opcional (tabela vazia é observação do P4b), só contada');
    assert.deepEqual(semDados.relacoes.opcionaisAusentes, { 'SEQUENCE OWNED BY': 1, 'TABLE DATA': 1 });
  });

  test('CB-03 — categoria conhecida mas não mapeada (particionada, partição-índice, visão, materializada, estrangeira, composta, toast) é CATEGORIA_NAO_MAPEADA; relkind desconhecido é forma inválida', () => {
    for (const relkind of ['p', 'I', 'v', 'm', 'f', 'c', 't']) {
      const inv = inventarioBase({ relacoes: [...inventarioBase().relacoes, rel('nova', relkind)] });
      const r = C.compararInventarioComSumario({ inventario: inv, sumario: sumarioDe([...LINHAS_COMPLETAS, '9; 0 0 VIEW public nova dono']) });
      assert.equal(r.ok, false, relkind);
      assert.deepEqual(r.motivos, ['CATEGORIA_NAO_MAPEADA'], relkind);
      assert.deepEqual(r.relacoes.categoriasNaoMapeadas, [`public.nova:${relkind}`]);
    }
    const inv = inventarioBase({ relacoes: [rel('x', 'z')] });
    assert.throws(() => C.compararInventarioComSumario({ inventario: inv, sumario: sumarioDe(LINHAS_COMPLETAS) }), (e) => e.code === 'INVENTARIO_INVALIDO');
  });

  test('CB-04 — motivos do sumário propagam (truncado, não interpretadas, formato); entrada do sumário sem inventário é só informativa', () => {
    const truncado = S.lerSumario(`${CABECALHO(9)}\n${LINHAS_COMPLETAS.join('\n')}\n`, { limites: { maxEntradas: 3 } });
    const r1 = C.compararInventarioComSumario({ inventario: inventarioBase(), sumario: truncado });
    assert.ok(r1.motivos.includes('SUMARIO_TRUNCADO') && r1.motivos.includes('RELACAO_AUSENTE_NO_DUMP'));
    const r2 = C.compararInventarioComSumario({ inventario: inventarioBase(), sumario: sumarioDe([...LINHAS_COMPLETAS, '7; 0 0 COISA public x dono']) });
    assert.deepEqual(r2.motivos, ['CONTAGEM_DIVERGENTE', 'ENTRADAS_NAO_INTERPRETADAS'].filter((m) => r2.motivos.includes(m)));
    assert.ok(r2.motivos.includes('ENTRADAS_NAO_INTERPRETADAS'));
    const r3 = C.compararInventarioComSumario({ inventario: inventarioBase(), sumario: sumarioDe([...LINHAS_COMPLETAS, '8; 1259 1 TABLE public extra dono']) });
    assert.equal(r3.ok, true);
    assert.equal(r3.relacoes.entradasSemInventario, 1);
    const tar = S.lerSumario(`${CABECALHO(9).replace('CUSTOM', 'TAR')}\n${LINHAS_COMPLETAS.join('\n')}\n`);
    assert.deepEqual(C.compararInventarioComSumario({ inventario: inventarioBase(), sumario: tar }).motivos, ['FORMATO_NAO_CUSTOM']);
    assert.throws(() => C.compararInventarioComSumario({ inventario: inventarioBase(), sumario: { ok: true } }), (e) => e.code === 'SUMARIO_INVALIDO');
    assert.throws(() => C.compararInventarioComSumario({ inventario: inventarioBase(), sumario: tar, extra: 1 }), (e) => e.code === 'ENTRADA_INVALIDA');
  });

  test('CB-05 — o mapa v1 é explícito, congelado e OBSERVADO com evidência citada (CI 41693689221); categorias existentes no projeto têm regra, as demais são null', () => {
    const M = C.MAPA_DE_CORRESPONDENCIA;
    assert.equal(M.versao, 1);
    assert.equal(M.observadoEm, '2026-11-03');
    assert.deepEqual(M.observacao, {
      ci: 'github-actions:41693689221', commit: 'c862a7232e20679fd6ab92e039306ee6f9129837', servidor: '16.15',
      dumpSha256: '244f54752665bd3792390ab32b05e638fdb71ce67eb7eb32bb2812f33b739459', relacoes: 417, contradicoes: 0,
      entradasOcultas: ['ENCODING', 'STDSTRINGS', 'SEARCHPATH', 'DATABASE', 'COMMENT'],
    });
    assert.ok(Object.isFrozen(M) && Object.isFrozen(M.categorias) && Object.isFrozen(M.observacao));
    assert.deepEqual(Object.keys(M.categorias).sort(), ['I', 'S', 'c', 'f', 'i', 'i:restricao', 'm', 'p', 'r', 't', 'v']);
    assert.deepEqual(M.categorias.r, { obrigatorias: ['TABLE'], opcionais: ['TABLE DATA'] });
    assert.deepEqual(M.categorias['i:restricao'], { obrigatorias: ['CONSTRAINT'], opcionais: [] });
    for (const k of ['p', 'I', 'v', 'm', 'f', 'c', 't']) assert.equal(M.categorias[k], null);
  });
});

describe('[ES] impressão digital e compatibilidade do esquema', () => {
  test('ES-01 — impressão digital: quantidade, última e SHA-256 da lista ordenada; sufixo .sql normalizado; vazio tem última null', () => {
    const a = C.impressaoDigitalDoEsquema({ migrationsDoBanco: MIGRATIONS });
    const b = C.impressaoDigitalDoEsquema({ migrationsDoBanco: MIGRATIONS.map((m) => `${m}.sql`) });
    assert.deepEqual(a, b);
    assert.equal(a.quantidade, 3);
    assert.equal(a.ultima, '002_create_perfis');
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
    assert.notEqual(a.sha256, C.impressaoDigitalDoEsquema({ migrationsDoBanco: [...MIGRATIONS].reverse() }).sha256, 'a ordem faz parte da impressão');
    assert.deepEqual(C.impressaoDigitalDoEsquema({ migrationsDoBanco: [] }).ultima, null);
    for (const ruim of [['1_x'], ['001_a', '001_a'], ['001_A'], [1], 'x']) assert.throws(() => C.impressaoDigitalDoEsquema({ migrationsDoBanco: ruim }), (e) => e.code === 'MIGRATIONS_INVALIDAS');
  });

  test('ES-02 — compatibilidade por prefixo: IGUAL, BANCO_ATRAS (migração pendente, compatível), BANCO_A_FRENTE (recusa), DIVERGENTE (recusa)', () => {
    const codigo = MIGRATIONS;
    assert.deepEqual(C.compatibilidadeDeEsquema({ migrationsDoBanco: codigo, migrationsDoCodigo: codigo }),
      { relacao: 'IGUAL', compativel: true, codigo: null, prefixoComum: 3, faltamNoBanco: 0, sobramNoBanco: 0, migracaoPendente: false });
    assert.deepEqual(C.compatibilidadeDeEsquema({ migrationsDoBanco: codigo.slice(0, 2), migrationsDoCodigo: codigo }),
      { relacao: 'BANCO_ATRAS_DO_CODIGO', compativel: true, codigo: null, prefixoComum: 2, faltamNoBanco: 1, sobramNoBanco: 0, migracaoPendente: true });
    assert.deepEqual(C.compatibilidadeDeEsquema({ migrationsDoBanco: [...codigo, '003_futura'], migrationsDoCodigo: codigo }),
      { relacao: 'BANCO_A_FRENTE_DO_CODIGO', compativel: false, codigo: 'ESQUEMA_A_FRENTE_DO_CODIGO', prefixoComum: 3, faltamNoBanco: 0, sobramNoBanco: 1, migracaoPendente: false });
    assert.deepEqual(C.compatibilidadeDeEsquema({ migrationsDoBanco: ['000_create_function_set_atualizado_em', '001_outra'], migrationsDoCodigo: codigo }),
      { relacao: 'DIVERGENTE', compativel: false, codigo: 'ESQUEMA_DIVERGENTE', prefixoComum: 1, faltamNoBanco: 2, sobramNoBanco: 1, migracaoPendente: false });
    assert.throws(() => C.compatibilidadeDeEsquema({ migrationsDoBanco: codigo, migrationsDoCodigo: ['x'] }), (e) => e.code === 'MIGRATIONS_DO_CODIGO_INVALIDAS');
  });
});

describe('[BL] bloco cobertura.postgres', () => {
  test('BL-01 — avaliação completa com sumário íntegro: nivelCalculado N1 e, com o mapa observado no P4b, nivelAtingido N1 sem motivos', () => {
    const bloco = C.avaliarCoberturaPostgres({ inventario: inventarioBase(), sumario: sumarioDe(LINHAS_COMPLETAS), migrationsDoCodigo: MIGRATIONS });
    assert.equal(bloco.versaoContratoPostgres, 1);
    assert.equal(bloco.nivelCalculado, 'N1');
    assert.equal(bloco.nivelAtingido, 'N1');
    assert.deepEqual(bloco.motivos, []);
    assert.equal(bloco.relacoes.mapa.observado, true);
    assert.deepEqual(Object.keys(bloco).sort(), [...C.CHAVES_DO_BLOCO].sort());
    assert.equal(bloco.relacoes.correspondidas, 4);
    assert.equal(bloco.esquema.quantidade, 3);
    assert.equal(bloco.esquema.compatibilidade.relacao, 'IGUAL');
    assert.deepEqual(bloco.dependenciasExternas.naoCobertosPeloDump, C.NAO_COBERTOS_PELO_DUMP);
    assert.equal(bloco.dependenciasExternas.verificadas, false);
    assert.deepEqual(bloco.dependenciasExternas.servidor, { versao: '16.4', encoding: 'UTF8', collate: 'C', ctype: 'C' });
    assert.deepEqual(C.validarBlocoPostgres(bloco), { valido: true, erros: [] });
    assert.ok(Object.isFrozen(bloco) && Object.isFrozen(bloco.esquema) && Object.isFrozen(bloco.dependenciasExternas));
    assert.ok(!Object.keys(C).some((k) => /observ|forcar|ignorar/i.test(k) && typeof C[k] === 'function'), 'não existe função que marque o mapa como observado');
  });

  test('BL-02 — qualquer falha das verificações puras leva nivelCalculado a N0 com o motivo específico (ausente, não mapeada, truncado, esquema divergente/à frente, sem migrations)', () => {
    const avaliar = (inv, sumario, codigo = MIGRATIONS) => C.avaliarCoberturaPostgres({ inventario: inv, sumario, migrationsDoCodigo: codigo });
    const casos = [
      [avaliar(inventarioBase(), sumarioDe(sem('INDEX public'))), 'RELACAO_AUSENTE_NO_DUMP'],
      [avaliar(inventarioBase({ relacoes: [...inventarioBase().relacoes, rel('v', 'v')] }), sumarioDe(LINHAS_COMPLETAS)), 'CATEGORIA_NAO_MAPEADA'],
      [avaliar(inventarioBase(), S.lerSumario(`${CABECALHO(9)}\n${LINHAS_COMPLETAS.join('\n')}\n`, { limites: { maxEntradas: 8 } })), 'SUMARIO_TRUNCADO'],
      [avaliar(inventarioBase({ migrations: [...MIGRATIONS, '003_futura'] }), sumarioDe(LINHAS_COMPLETAS)), 'ESQUEMA_A_FRENTE_DO_CODIGO'],
      [avaliar(inventarioBase({ migrations: ['000_create_function_set_atualizado_em', '001_x'] }), sumarioDe(LINHAS_COMPLETAS)), 'ESQUEMA_DIVERGENTE'],
      [avaliar(inventarioBase({ migrations: [] }), sumarioDe(LINHAS_COMPLETAS)), 'SEM_MIGRATIONS_APLICADAS'],
    ];
    for (const [bloco, motivo] of casos) {
      assert.equal(bloco.nivelCalculado, 'N0', motivo);
      assert.equal(bloco.nivelAtingido, 'N0', motivo);
      assert.ok(bloco.motivos.includes(motivo) && !bloco.motivos.includes('MAPA_NAO_OBSERVADO'), `${motivo}: ${bloco.motivos}`);
      assert.deepEqual(C.validarBlocoPostgres(bloco), { valido: true, erros: [] });
    }
    const atras = avaliar(inventarioBase({ migrations: MIGRATIONS.slice(0, 2) }), sumarioDe(LINHAS_COMPLETAS));
    assert.equal(atras.nivelCalculado, 'N1', 'banco atrás do código não invalida o backup');
    assert.equal(atras.esquema.compatibilidade.migracaoPendente, true);
  });

  test('BL-03 — blocoN0 e validação fechada: chaves exatas, versão conhecida, null só em N0, nível atingido nunca acima do calculado, motivos em código', () => {
    const n0 = C.blocoN0();
    assert.deepEqual(n0, { versaoContratoPostgres: 1, nivelAtingido: 'N0', nivelCalculado: 'N0', relacoes: null, esquema: null, dependenciasExternas: null, motivos: ['NAO_EXECUTADO'] });
    assert.deepEqual(C.validarBlocoPostgres(n0), { valido: true, erros: [] });
    assert.deepEqual(C.validarBlocoPostgres({ ...n0, nivelAtingido: 'N1' }).erros, ['NIVEL_ACIMA_DO_CALCULADO', 'NULO_FORA_DO_N0']);
    assert.deepEqual(C.validarBlocoPostgres({ ...n0, nivelAtingido: 'N1', nivelCalculado: 'N1' }).erros, ['NULO_FORA_DO_N0']);
    assert.deepEqual(C.validarBlocoPostgres({ ...n0, extra: 1 }).erros, ['CHAVES_DO_BLOCO_INVALIDAS']);
    assert.deepEqual(C.validarBlocoPostgres({ ...n0, versaoContratoPostgres: 2 }).erros, ['VERSAO_DO_CONTRATO_DESCONHECIDA']);
    assert.deepEqual(C.validarBlocoPostgres({ ...n0, nivelAtingido: 'N9' }).erros, ['NIVEL_INVALIDO', 'NULO_FORA_DO_N0']);
    assert.deepEqual(C.validarBlocoPostgres({ ...n0, relacoes: 'x' }).erros, ['SUBBLOCO_INVALIDO']);
    assert.deepEqual(C.validarBlocoPostgres({ ...n0, motivos: ['mensagem livre com espaços'] }).erros, ['MOTIVOS_INVALIDOS']);
    assert.deepEqual(C.validarBlocoPostgres(null).erros, ['BLOCO_AUSENTE']);
    const { relacoes, ...semChave } = n0;
    assert.ok(!C.validarBlocoPostgres(semChave).valido);
  });

  test('BL-04 — junção com as regras do catálogo (J1): nivelPostgres N0 nunca resulta COMPLETA, mesmo com fonte POSTGRES aprovada dinamicamente', () => {
    const catalogo = obterCatalogo();
    const base = { raizesConfiguradas: [], resultadosDinamicos: Object.fromEntries(catalogo.fontes.map((f) => [f.id, 'APROVADO'])) };
    const n0 = R.avaliarCobertura(catalogo, { ...base, nivelPostgres: 'N0' });
    assert.notEqual(n0.teto, 'COMPLETA');
    assert.ok(R.NIVEIS_POSTGRES.includes('N1') && !['N0'].some((n) => R.avaliarCobertura(catalogo, { ...base, nivelPostgres: n }).teto === 'COMPLETA'));
    const blocoN1 = C.avaliarCoberturaPostgres({ inventario: inventarioBase(), sumario: sumarioDe(LINHAS_COMPLETAS), migrationsDoCodigo: MIGRATIONS });
    assert.equal(blocoN1.nivelAtingido, 'N1');
    assert.ok(R.NIVEIS_POSTGRES.includes(blocoN1.nivelAtingido) && C.NIVEIS.every((n) => R.NIVEIS_POSTGRES.includes(n)), 'níveis do contrato = níveis das regras');
    // N1 remove só o motivo do nível: o catálogo real continua com fontes pendentes, logo o teto segue abaixo de COMPLETA.
    const n1 = R.avaliarCobertura(catalogo, { ...base, nivelPostgres: blocoN1.nivelAtingido });
    assert.notEqual(n1.teto, 'COMPLETA');
    assert.ok(!n1.motivos.some((m) => m.startsWith('NIVEL_POSTGRES_INSUFICIENTE')) && n1.motivos.some((m) => m.startsWith('PENDENCIA:')));
  });
});
