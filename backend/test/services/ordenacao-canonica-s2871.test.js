'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const C = require('../../src/services/backup-fontes-postgres-cobertura.service');
const S = require('../../src/services/backup-fontes-postgres-sumario.service');
const J = require('../../src/utils/janela-escrita-imagens');
const P4b = require('../helpers/p4b-caracterizacao');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');

/**
 * Sonar S2871, lotes S1 (cobertura e sumário PostgreSQL), S2 (janela de escrita das imagens) e S3 (caracterização P4b): o comparador explícito
 * preserva a ordem do sort() padrão, que compara unidades de código UTF-16. Oráculo: a saída é uma permutação do esperado e não decresce nessa
 * ordem, o que determina a saída do sort() padrão de forma única para strings. Cada caso também prova que localeCompare daria outra ordem.
 */

const BACKEND = path.join(__dirname, '..', '..');
const ARQUIVOS_DOS_LOTES = [
  'src/services/backup-fontes-postgres-cobertura.service.js',
  'src/services/backup-fontes-postgres-sumario.service.js',
  'src/utils/janela-escrita-imagens.js',
  'test/helpers/p4b-caracterizacao.js',
];

const compararTexto = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
const naoDecresce = (lista) => lista.every((v, i) => i === 0 || !(v < lista[i - 1]));
const mesmosElementos = (lista, esperado) => assert.deepEqual([...lista].sort(compararTexto), [...esperado].sort(compararTexto));
const exigirOrdemPadrao = (lista, esperado, rotulo) => {
  mesmosElementos(lista, esperado);
  assert.ok(naoDecresce(lista), `${rotulo}: fora da ordem por unidades de código: ${JSON.stringify(lista)}`);
};
const exigirSensivelALocale = (esperado) => {
  const porCodigo = [...esperado].sort(compararTexto);
  const porLocale = [...esperado].sort((a, b) => a.localeCompare(b));
  assert.notDeepEqual(porLocale, porCodigo, 'o caso precisa distinguir a ordem por unidades de código da ordem de localeCompare');
};

const CABECALHO = (n, formato = 'CUSTOM') => [`;     TOC Entries: ${n}`, `;     Format: ${formato}`, ';     Dumped from database version: 16.4', '; Selected TOC Entries:'].join('\n');
const sumarioDe = (linhas, formato) => S.lerSumario(`${CABECALHO(linhas.length, formato)}\n${linhas.join('\n')}\n`);
const rel = (esquema, nome, relkind = 'r', extra = {}) => ({ esquema, nome, relkind, sustentaRestricao: false, sequenciaImplicita: false, ...extra });
const MIGRATIONS = ['000_create_function_set_atualizado_em', '001_create_empresas', '002_create_perfis'];
const inventarioCom = (relacoes, extra = {}) => ({
  relacoes,
  outros: { FUNCTION: 0, TRIGGER: 0, TYPE: 0, EXTENSION: 0, RULE: 0, POLICY: 0, PUBLICATION: 0, 'EVENT TRIGGER': 0, SCHEMA: 0 },
  extensoes: [{ nome: 'plpgsql', versao: '1.0' }],
  servidor: { versao: '16.4', encoding: 'UTF8', collate: 'C', ctype: 'C' },
  migrations: MIGRATIONS,
  ...extra,
});
// `_` (0x5F), dígitos, `.` e `:` em posições onde a ordem por unidades de código e a de localeCompare divergem.
const NOMES = ['a', 'a_', 'a_b', 'a0', 'a1', 'aa', 'ab', '_a', '_0', 'z', 'a__b', 'a_0'];
const ESQUEMAS = ['public', 'a', 'a_'];
const invertida = (lista) => [...lista].sort(compararTexto).reverse();

describe('[ORD] S2871 — sort() explícito nos arquivos dos lotes S1, S2 e S3', () => {
  for (const relativo of ARQUIVOS_DOS_LOTES) {
    test(`ORD-00 — ${relativo}: nenhum sort() sem comparador e nenhum localeCompare`, () => {
      const texto = fs.readFileSync(path.join(BACKEND, relativo), 'utf8');
      assert.doesNotMatch(texto, /\.sort\(\s*\)/);
      assert.doesNotMatch(texto, /localeCompare/);
    });
  }
});

describe('[ORD-S1] cobertura e sumário PostgreSQL preservam a ordem do sort() padrão', () => {
  test('ORD-01 — relações ausentes no dump e categorias não mapeadas saem na ordem por unidades de código, qualquer que seja a ordem do inventário', () => {
    const mapeadas = [];
    const naoMapeadas = [];
    for (const esquema of ESQUEMAS) for (const nome of NOMES.slice(0, 6)) mapeadas.push(rel(esquema, nome, 'r'));
    for (const nome of NOMES) naoMapeadas.push(rel('a', nome, 'v'));
    const relacoes = [...mapeadas, ...naoMapeadas].reverse();
    const r = C.compararInventarioComSumario({ inventario: inventarioCom(relacoes), sumario: sumarioDe([]) });
    const ausentes = mapeadas.map((x) => `${x.esquema}.${x.nome}:TABLE`);
    const categorias = naoMapeadas.map((x) => `${x.esquema}.${x.nome}:v`);
    exigirSensivelALocale(ausentes);
    exigirSensivelALocale(categorias);
    exigirOrdemPadrao(r.relacoes.ausentes, ausentes, 'ausentes');
    exigirOrdemPadrao(r.relacoes.categoriasNaoMapeadas, categorias, 'categoriasNaoMapeadas');
  });

  test('ORD-02 — motivos da comparação e do bloco de cobertura: mesmos elementos, em ordem por unidades de código', () => {
    const inventario = inventarioCom([rel('public', 'a_b', 'r'), rel('public', 'ab', 'm')]);
    const sumario = sumarioDe([], 'DIRECTORY');
    const comparacao = C.compararInventarioComSumario({ inventario, sumario });
    const esperadoComparacao = new Set([...sumario.motivos, 'FORMATO_NAO_CUSTOM', 'RELACAO_AUSENTE_NO_DUMP', 'CATEGORIA_NAO_MAPEADA']);
    exigirOrdemPadrao(comparacao.motivos, esperadoComparacao, 'motivos da comparação');

    const bloco = C.avaliarCoberturaPostgres({ inventario, sumario, migrationsDoCodigo: ['000_create_function_set_atualizado_em', '009_outra'] });
    exigirOrdemPadrao(bloco.motivos, new Set([...esperadoComparacao, 'ESQUEMA_DIVERGENTE']), 'motivos do bloco');
  });

  test('ORD-03 — motivos do sumário do dump: mesmos elementos, em ordem por unidades de código', () => {
    const sumario = S.lerSumario('; Selected TOC Entries:\nlinha que não é do TOC\n');
    assert.ok(sumario.motivos.length >= 3, JSON.stringify(sumario.motivos));
    for (const m of ['FORMATO_AUSENTE', 'CONTAGEM_AUSENTE', 'ENTRADAS_NAO_INTERPRETADAS']) assert.ok(sumario.motivos.includes(m), m);
    exigirOrdemPadrao(sumario.motivos, sumario.motivos, 'motivos do sumário');
  });
});

describe('[ORD-S2] janela de escrita das imagens: aceite e recusa do documento não dependem da ordem das chaves', () => {
  const raizes = [];
  after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
  const arquivoNovo = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return path.join(raiz, 'janela-imagens.lock'); };
  const VALORES = { hospedeiro: 'host-de-teste', iniciadoEm: '2026-11-26T12:00:00.000Z', pid: 4242, tipo: 'BACKUP', token: 'ab'.repeat(16), versao: 1 };
  const permutacoes = (lista) => (lista.length <= 1 ? [lista] : lista.flatMap((x, i) => permutacoes([...lista.slice(0, i), ...lista.slice(i + 1)]).map((p) => [x, ...p])));
  const gravar = (arquivo, pares) => fs.writeFileSync(arquivo, `{${pares.map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`).join(',')}}\n`);
  const recusa = async (arquivo) => assert.rejects(J.lerJanela({ arquivo }), (e) => e.codigo === 'JANELA_DOCUMENTO_INVALIDO');

  test('ORD-04 — as 720 ordens possíveis das seis chaves produzem o mesmo dono', async () => {
    const arquivo = arquivoNovo();
    const ordens = permutacoes(Object.keys(VALORES));
    assert.equal(ordens.length, 720);
    const esperado = { versao: 1, tipo: 'BACKUP', pid: 4242, hospedeiro: 'host-de-teste', iniciadoEm: '2026-11-26T12:00:00.000Z' };
    for (const ordem of ordens) {
      gravar(arquivo, ordem.map((k) => [k, VALORES[k]]));
      assert.deepEqual(await J.lerJanela({ arquivo }), esperado, ordem.join(','));
    }
  });

  test('ORD-05 — chave a mais, a menos ou parecida (caixa, acento) é recusada, em qualquer posição', async () => {
    const arquivo = arquivoNovo();
    const base = Object.entries(VALORES);
    const casos = [
      [...base, ['Token', VALORES.token]],
      [['Token', VALORES.token], ...base],
      base.filter(([k]) => k !== 'pid'),
      base.map(([k, v]) => [k === 'token' ? 'Token' : k, v]),
      base.map(([k, v]) => [k === 'token' ? 'tokén' : k, v]),
      base.map(([k, v]) => [k === 'tipo' ? 'TIPO' : k, v]),
    ];
    for (const pares of casos) {
      gravar(arquivo, pares);
      await recusa(arquivo);
    }
  });
});

describe('[ORD-S3] caracterização P4b preserva a ordem do sort() padrão', () => {
  test('ORD-06 — contradições da observação: mesmos elementos, em ordem por unidades de código (maiúscula `S` antes de minúsculas)', () => {
    const relacoes = [
      rel('public', 'tabela_sem_toc', 'r'),
      rel('public', 'tabela_x', 'r'),
      rel('public', 'seq_sem_toc', 'S'),
      rel('public', 'idx_sem_toc', 'i'),
      rel('public', 'pk_sem_toc', 'i', { sustentaRestricao: true }),
      rel('public', 'visao', 'v'),
      rel('public', 'materializada', 'm'),
    ].reverse();
    const sumario = { entradas: [{ esquema: 'public', nome: 'tabela_x', tipo: 'TABLE' }, { esquema: 'public', nome: 'tabela_x', tipo: 'SEQUENCE' }] };
    const r = P4b.caracterizarObservacao({ inventario: { relacoes }, sumario, esquema: 'public' });
    const esperado = [
      'OBRIGATORIA_NAO_UNIVERSAL:r:TABLE',
      'TIPO_NAO_PREVISTO:r:SEQUENCE',
      'OBRIGATORIA_NAO_UNIVERSAL:S:SEQUENCE',
      'OBRIGATORIA_NAO_UNIVERSAL:i:INDEX',
      'OBRIGATORIA_NAO_UNIVERSAL:i:restricao:CONSTRAINT',
      'CATEGORIA_NAO_MAPEADA_OBSERVADA:v',
      'CATEGORIA_NAO_MAPEADA_OBSERVADA:m',
    ];
    exigirSensivelALocale(esperado);
    exigirOrdemPadrao(r.contradicoes, esperado, 'contradicoes');
  });

  test('ORD-07 — relações que faltam ou sobram no restaurado: mesmos elementos, em ordem por unidades de código (`_` antes de `|`)', () => {
    const origem = { relacoes: NOMES.map((n) => rel('public', n, 'r')).reverse(), migrations: MIGRATIONS };
    const restaurado = { relacoes: NOMES.map((n) => rel('public', `${n}_r`, 'r')), migrations: MIGRATIONS };
    const r = P4b.compararRestauracao({ origem, restaurado, esquema: 'public' });
    const tupla = (x) => `${x.esquema}|${x.nome}|${x.relkind}|${x.sustentaRestricao}|${x.sequenciaImplicita}`;
    const faltam = origem.relacoes.map(tupla);
    const sobram = restaurado.relacoes.map(tupla);
    exigirSensivelALocale(faltam);
    exigirOrdemPadrao(r.relacoes.faltamNoRestaurado, faltam, 'faltamNoRestaurado');
    exigirOrdemPadrao(r.relacoes.sobramNoRestaurado, sobram, 'sobramNoRestaurado');
  });
});
