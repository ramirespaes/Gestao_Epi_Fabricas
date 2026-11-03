'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const S = require('../../src/services/backup-fontes-postgres-sumario.service');

/**
 * D-ORF-6, P4a — LEITOR EM FLUXO do sumário de `pg_restore --list`. Texto SINTÉTICO no formato documentado do PostgreSQL 16 [NV até o P4b]:
 * nenhum processo, arquivo ou banco.
 */

const CABECALHO = [
  ';', '; Archive created at 2026-11-03 10:00:00 -0300', ';     dbname: banco_secreto_xyz', ';     TOC Entries: {N}', ';     Compression: -1',
  ';     Dump Version: 1.14-0', ';     Format: CUSTOM', ';     Integer: 4 bytes', ';     Offset: 8 bytes', ';     Dumped from database version: 16.4',
  ';     Dumped by pg_dump version: 16.4', ';', ';', '; Selected TOC Entries:', ';',
].join('\n');

const ENTRADAS_BASE = [
  '3500; 0 0 ENCODING - ENCODING',
  '3501; 0 0 STDSTRINGS - STDSTRINGS',
  '3502; 0 0 SEARCHPATH - SEARCHPATH',
  '3503; 1262 16384 DATABASE - banco_secreto_xyz dono_secreto',
  '215; 1259 16400 TABLE public empresas dono_secreto',
  '216; 1259 16410 SEQUENCE public empresas_id_seq dono_secreto',
  '3400; 0 16400 TABLE DATA public empresas dono_secreto',
  '3401; 0 0 SEQUENCE SET public empresas_id_seq dono_secreto',
  '3600; 2606 16500 CONSTRAINT public empresas empresas_pkey dono_secreto',
  '3601; 1259 16501 INDEX public idx_empresas_cnpj dono_secreto',
  '3700; 2606 16600 FK CONSTRAINT public usuarios usuarios_empresa_id_fkey dono_secreto',
  '3800; 2620 16700 TRIGGER public empresas trg_atualizado_em dono_secreto',
  '220; 1255 16800 FUNCTION public set_atualizado_em() dono_secreto',
  '221; 1255 16801 FUNCTION public fn_duas(integer, text) dono_secreto',
  '3100; 0 0 COMMENT - EXTENSION plpgsql',
  '3900; 0 0 ACL - SCHEMA public dono_secreto',
];

const sumarioDe = (entradas, n = entradas.length) => `${CABECALHO.replace('{N}', String(n))}\n${entradas.join('\n')}\n`;

describe('[SM] leitor do sumário de pg_restore --list', () => {
  test('SM-01 — sumário sintético válido: cabeçalho, tuplas por tipo, contagens; dono, OIDs e nome do banco nunca retidos; saída congelada', () => {
    const r = S.lerSumario(sumarioDe(ENTRADAS_BASE));
    assert.equal(r.ok, true, JSON.stringify(r.motivos));
    assert.deepEqual(r.cabecalho, { formato: 'CUSTOM', entradasDeclaradas: 16, versaoServidor: '16.4', versaoPgDump: '16.4' });
    assert.deepEqual(r.contagem, {
      total: 16, interpretadas: 16, naoInterpretadas: 0, ocultas: 0,
      porTipo: { ACL: 1, COMMENT: 1, CONSTRAINT: 1, DATABASE: 1, ENCODING: 1, 'FK CONSTRAINT': 1, FUNCTION: 2, INDEX: 1, SEARCHPATH: 1, SEQUENCE: 1, 'SEQUENCE SET': 1, STDSTRINGS: 1, TABLE: 1, 'TABLE DATA': 1, TRIGGER: 1 },
    });
    assert.deepEqual(r.entradas.find((e) => e.tipo === 'TABLE'), { tipo: 'TABLE', esquema: 'public', nome: 'empresas', relacao: null });
    assert.deepEqual(r.entradas.find((e) => e.tipo === 'CONSTRAINT'), { tipo: 'CONSTRAINT', esquema: 'public', nome: 'empresas_pkey', relacao: 'empresas' });
    assert.deepEqual(r.entradas.find((e) => e.tipo === 'TRIGGER'), { tipo: 'TRIGGER', esquema: 'public', nome: 'trg_atualizado_em', relacao: 'empresas' });
    assert.deepEqual(r.entradas.filter((e) => e.tipo === 'FUNCTION').map((e) => e.nome), ['set_atualizado_em', 'fn_duas']);
    assert.deepEqual(r.entradas.find((e) => e.tipo === 'DATABASE'), { tipo: 'DATABASE', esquema: null, nome: null, relacao: null });
    const serializado = JSON.stringify(r);
    assert.ok(!/secreto|16400|1259/.test(serializado), 'dono, OIDs e nome do banco não podem ser retidos');
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.entradas) && r.entradas.every(Object.isFrozen) && Object.isFrozen(r.cabecalho));
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
    assert.equal(r.truncado, false);
  });

  test('SM-02 — leitura em fluxo: blocos cortados no meio de linha, CRLF e Buffer produzem o mesmo resultado que o texto inteiro', () => {
    const texto = sumarioDe(ENTRADAS_BASE);
    const inteiro = S.lerSumario(texto);
    const leitor = S.criarLeitorDeSumario();
    for (let i = 0; i < texto.length; i += 7) leitor.alimentar(Buffer.from(texto.slice(i, i + 7), 'latin1'));
    const emBlocos = leitor.concluir();
    assert.deepEqual(emBlocos, inteiro);
    const crlf = S.lerSumario(texto.replace(/\n/g, '\r\n'));
    assert.deepEqual(crlf.entradas, inteiro.entradas);
    assert.equal(crlf.sha256, inteiro.sha256);
    assert.throws(() => leitor.alimentar('x'), TypeError);
    assert.throws(() => leitor.concluir(), TypeError);
  });

  test('SM-03 — falha fechada: tipo desconhecido, identificador com aspas, linha fora do formato e rotina sem parênteses são NÃO INTERPRETADAS, contadas e reprovam', () => {
    const r = S.lerSumario(sumarioDe([
      ...ENTRADAS_BASE,
      '4000; 1259 17000 OBJETO ESTRANHO public coisa dono',
      '4001; 1259 17001 TABLE public "Com Espaco" dono',
      'linha sem formato algum',
      '4002; 1255 17002 FUNCTION public sem_parenteses dono',
      '4003; 1259 17003 TABLE public so_nome',
    ]));
    assert.equal(r.ok, false);
    assert.deepEqual(r.motivos, ['ENTRADAS_NAO_INTERPRETADAS']);
    assert.equal(r.contagem.total, 21);
    assert.equal(r.contagem.naoInterpretadas, 5);
    assert.equal(r.contagem.interpretadas, 16);
  });

  test('SM-04 — cabeçalho: formato ausente, formato não CUSTOM, contagem ausente ou divergente e sumário vazio são motivos distintos', () => {
    const semFormato = S.lerSumario(sumarioDe(ENTRADAS_BASE).replace(';     Format: CUSTOM\n', ''));
    assert.deepEqual(semFormato.motivos, ['FORMATO_AUSENTE']);
    const tar = S.lerSumario(sumarioDe(ENTRADAS_BASE).replace('Format: CUSTOM', 'Format: TAR'));
    assert.deepEqual(tar.motivos, ['FORMATO_NAO_CUSTOM']);
    assert.equal(tar.cabecalho.formato, 'TAR');
    const semContagem = S.lerSumario(sumarioDe(ENTRADAS_BASE).replace(/;     TOC Entries: \d+\n/, ''));
    assert.deepEqual(semContagem.motivos, ['CONTAGEM_AUSENTE']);
    const divergente = S.lerSumario(sumarioDe(ENTRADAS_BASE, 99));
    assert.deepEqual(divergente.motivos, ['CONTAGEM_DIVERGENTE'], 'ocultas acima do teto');
    assert.deepEqual(S.lerSumario(sumarioDe(ENTRADAS_BASE, 15)).motivos, ['CONTAGEM_DIVERGENTE'], 'mais linhas que o declarado');
    // Observado no P4b (CI 41683852389): o --list omite ENCODING, STDSTRINGS, SEARCHPATH, DATABASE e o COMMENT do banco (5 ocultas num dump real).
    const comOcultas = S.lerSumario(sumarioDe(ENTRADAS_BASE, 16 + 5));
    assert.deepEqual(comOcultas.motivos, []);
    assert.equal(comOcultas.contagem.ocultas, 5);
    assert.equal(S.lerSumario(sumarioDe(ENTRADAS_BASE, 16 + S.TETO_DE_ENTRADAS_OCULTAS)).ok, true);
    assert.equal(S.lerSumario(sumarioDe(ENTRADAS_BASE, 17 + S.TETO_DE_ENTRADAS_OCULTAS)).ok, false);
    const vazio = S.lerSumario(sumarioDe([], 0));
    assert.deepEqual(vazio.motivos, ['SUMARIO_VAZIO']);
    assert.deepEqual(S.lerSumario('').motivos, ['CONTAGEM_AUSENTE', 'FORMATO_AUSENTE', 'SUMARIO_VAZIO']);
  });

  test('SM-05 — tetos: excesso de entradas, de bytes ou linha longa marcam truncado + SUMARIO_TRUNCADO e param de reter (nunca silencioso)', () => {
    const muitas = Array.from({ length: 30 }, (_, i) => `${1000 + i}; 1259 ${20000 + i} TABLE public t_${i} dono`);
    const porEntradas = S.lerSumario(sumarioDe(muitas), { limites: { maxEntradas: 10 } });
    assert.equal(porEntradas.truncado, true);
    assert.ok(porEntradas.motivos.includes('SUMARIO_TRUNCADO'));
    assert.equal(porEntradas.entradas.length, 10);
    assert.ok(!porEntradas.motivos.includes('CONTAGEM_DIVERGENTE'), 'truncado não acusa contagem divergente');
    const porBytes = S.lerSumario(sumarioDe(ENTRADAS_BASE), { limites: { maxBytes: 200 } });
    assert.equal(porBytes.truncado, true);
    assert.ok(porBytes.motivos.includes('SUMARIO_TRUNCADO'));
    const leitor = S.criarLeitorDeSumario({ limites: { maxBytesDaLinha: 64 } });
    leitor.alimentar(`${CABECALHO.replace('{N}', '1')}\n`);
    leitor.alimentar(`5000; 1259 1 TABLE public ${'a'.repeat(100)} dono\n`);
    leitor.alimentar('5001; 1259 2 TABLE public depois dono\n');
    const porLinha = leitor.concluir();
    assert.equal(porLinha.truncado, true);
    assert.equal(porLinha.entradas.length, 0, 'nada depois do truncamento é retido');
    assert.throws(() => S.criarLeitorDeSumario({ limites: { maxEntradas: 0 } }), TypeError);
    assert.throws(() => S.criarLeitorDeSumario({ limites: { outra: 1 } }), TypeError);
    assert.throws(() => S.criarLeitorDeSumario({ x: 1 }), TypeError);
    assert.throws(() => S.criarLeitorDeSumario().alimentar(42), TypeError);
  });

  test('SM-06 — interpretarEntrada: casos de borda por família de tipo ("TABLE DATA" vence "TABLE"; esquema "-" é null; dono obrigatório fora dos contados)', () => {
    assert.deepEqual(S.interpretarEntrada('1; 0 1 TABLE DATA public x dono'), { tipo: 'TABLE DATA', esquema: 'public', nome: 'x', relacao: null });
    assert.deepEqual(S.interpretarEntrada('1; 0 1 SEQUENCE OWNED BY public x_id_seq dono'), { tipo: 'SEQUENCE OWNED BY', esquema: 'public', nome: 'x_id_seq', relacao: null });
    assert.deepEqual(S.interpretarEntrada('1; 0 1 MATERIALIZED VIEW DATA public mv dono'), { tipo: 'MATERIALIZED VIEW DATA', esquema: 'public', nome: 'mv', relacao: null });
    assert.deepEqual(S.interpretarEntrada('1; 0 1 EXTENSION - pgcrypto'), { tipo: 'EXTENSION', esquema: null, nome: null, relacao: null });
    assert.deepEqual(S.interpretarEntrada('1; 0 1 EVENT TRIGGER - evt dono'), { tipo: 'EVENT TRIGGER', esquema: null, nome: null, relacao: null });
    assert.equal(S.interpretarEntrada('1; 0 1 TABLE public x'), null, 'sem dono');
    assert.equal(S.interpretarEntrada('1; 0 1 TABLE Public x dono'), null, 'esquema fora do padrão');
    assert.equal(S.interpretarEntrada('1; 0 1 CONSTRAINT public x dono'), null, 'dependente precisa de relação e nome');
    assert.equal(S.interpretarEntrada('1; 0 1 CONSTRAINT public a b c dono'), null);
    assert.equal(S.interpretarEntrada('1; 0 1 TABLE'), null);
    assert.equal(S.interpretarEntrada('x; 0 1 TABLE public x dono'), null);
    assert.ok(S.TIPOS_DE_ENTRADA.length === new Set(S.TIPOS_DE_ENTRADA).size && Object.isFrozen(S.TIPOS_DE_ENTRADA));
  });

  test('SM-07 — ehSumario reconhece só o resultado do leitor', () => {
    assert.equal(S.ehSumario(S.lerSumario(sumarioDe(ENTRADAS_BASE))), true);
    assert.equal(S.ehSumario({ ok: true }), false);
    assert.equal(S.ehSumario(null), false);
  });
});
