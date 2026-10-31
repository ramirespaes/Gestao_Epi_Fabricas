'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Datas efetivas da situação do funcionário — guardas de escopo e contrato da migration, SEM PostgreSQL (RED, especificação 02).
 *
 * Duas famílias:
 *   - GUARDAS que já passam e devem continuar passando (nenhuma permissão, ação ou toggle novos; um único ponto de escrita da
 *     situação; exportação PDF/XLSX inalterada; nada dos conceitos descartados no código);
 *   - CONTRATOS da migration candidata, lidos do arquivo (número-agnóstico: a numeração final depende da ordem de integração com
 *     a LGPD-3): é uma migration aditiva, contígua à 095 e registrada no manifesto, que cria só funcionario_situacoes.
 */

const RAIZ = path.join(__dirname, '..', '..');
const SRC = path.join(RAIZ, 'src');
const MIGRATIONS = path.join(RAIZ, 'migrations');

function arquivos(dir, acumulado = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) arquivos(p, acumulado); else if (e.name.endsWith('.js')) acumulado.push(p);
  }
  return acumulado;
}
const relativo = (p) => path.relative(SRC, p).split(path.sep).join('/');
const FONTES = arquivos(SRC).map((p) => ({ rel: relativo(p), texto: fs.readFileSync(p, 'utf8') }));
const semComentarios = (sql) => sql.replace(/--[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

describe('guarda — nenhuma permissão, ação, toggle ou provisionamento novos', () => {
  test('os catálogos de RBAC mantêm os números atuais (a simplificação eliminou a ação de leitura de motivos)', () => {
    const r = require('../../src/rbac/recursos');
    const t = require('../../src/rbac/toggles');
    assert.equal(r.ACOES_COM_EFEITO.length, 16);
    assert.equal(r.RECURSOS_COM_EFEITO.length, 16);
    assert.equal(r.ESCOPO_PROVISIONAMENTO_MASTER.acoes.length, 9);
    assert.equal(r.ESCOPO_PROVISIONAMENTO_MASTER.recursos.length, 16);
    assert.equal(t.TOGGLES.length, 30);
    assert.equal(t.PENDENCIAS.length, 7);
    const nomes = JSON.stringify([r.ACOES_COM_EFEITO, t.TOGGLES.map((x) => x.id)]);
    assert.doesNotMatch(nomes, /MOTIVO|SITUACAO_FUNCIONARIO|motivoSituacao/i);
  });
});

describe('guarda — um único ponto de escrita da situação', () => {
  test('só o repositório de funcionários contém UPDATE em funcionarios', () => {
    const com = FONTES.filter((f) => /UPDATE\s+funcionarios\b/i.test(f.texto)).map((f) => f.rel);
    assert.deepEqual(com, ['repositories/funcionario.repository.js']);
  });

  test('só o serviço de funcionários chama atualizar() com situacao, e o histórico é escrito pelo repositório de situação', () => {
    const chamam = FONTES.filter((f) => /funcionarioRepo\.atualizar\(/.test(f.texto)).map((f) => f.rel);
    assert.deepEqual(chamam, ['services/funcionario.service.js']);
  });
});

describe('guarda — conceitos descartados não existem no código', () => {
  test('nada de previsão de retorno, confirmação de conflito, ação de leitura de motivos, motivo de situação ou descrição administrativa', () => {
    const proibidos = /previsaoRetorno|previsao_retorno|reconheceConflito|reconhece_conflito|conflito_reconhecido|VISUALIZAR_MOTIVO|motivoSituacao|motivo_situacao|descricaoAdministrativa/;
    const achados = FONTES.filter((f) => proibidos.test(f.texto)).map((f) => f.rel);
    assert.deepEqual(achados, []);
  });

  test('o schema da situação não declara motivo, descrição, observação, CID, diagnóstico nem INSS', () => {
    const schema = FONTES.find((f) => f.rel === 'schemas/funcionario.schema.js').texto;
    const trecho = schema.slice(schema.indexOf('const inativar'), schema.indexOf('// ── Importação em lote'));
    assert.doesNotMatch(trecho, /motivo|descricao|observacao|\bcid\b|diagnostico|inss|acidente/i);
  });
});

describe('guarda — a tabela nova é lida e escrita só por quem deve', () => {
  test('funcionario_situacoes aparece apenas no repositório próprio e no de eventos do histórico', () => {
    const achados = FONTES.filter((f) => /funcionario_situacoes/.test(f.texto)).map((f) => f.rel).sort();
    const permitidos = ['repositories/funcionario-eventos.repository.js', 'repositories/funcionario-situacao.repository.js'];
    for (const rel of achados) assert.ok(permitidos.includes(rel), `${rel} não deveria tocar funcionario_situacoes`);
  });

  test('relatórios, dashboard, LGPD, Token, fiscalização e exportação não leem a tabela nova', () => {
    const fora = FONTES.filter((f) => /^(repositories|services)\/(relatorio|dashboard|lgpd|token|fiscalizacao|exportacao|itens-disponiveis|estoque|entrega)/.test(f.rel));
    assert.ok(fora.length > 0);
    assert.deepEqual(fora.filter((f) => /funcionario_situacoes|dataEfetiva/.test(f.texto)).map((f) => f.rel), []);
  });
});

describe('guarda — exportação do histórico (D2) permanece como está', () => {
  const { estruturar } = require('../../src/services/exportacao-historico/formatacao');
  const modelo = (situacao) => ({
    empresa: { nome: 'Empresa Fictícia' }, emitidoEm: '2026-10-11T01:30:00Z', periodo: null,
    funcionario: { nome: 'Tício', matricula: 'M-1', setor: 'S', funcao: 'F', ghe: null, situacao: 'INATIVO' },
    indicadores: null, entregas: null, ghe: [], cadastral: [], situacao,
  });

  test('a seção de situação mantém exatamente as colunas atuais e ignora a data efetiva', () => {
    const doc = estruturar(modelo([{
      tipo: 'ALTERACAO', ocorridoEm: '2026-10-11T01:30:00Z', anterior: 'ATIVO', novo: 'INATIVO', responsavel: { id: 7, nome: 'Responsável' }, dataEfetiva: '2026-03-05',
    }]));
    const secao = doc.secoes.find((s) => s.id === 'situacao');
    assert.deepEqual(secao.colunas, ['Data', 'Hora', 'Tipo', 'Situação anterior', 'Situação nova', 'Responsável']);
    assert.equal(secao.linhas.length, 1);
    assert.deepEqual(secao.linhas[0], ['10/10/2026', '22:30', 'Alteração', 'Ativo', 'Inativo', 'Responsável']);
    const tudo = JSON.stringify(doc);
    assert.equal(tudo.includes('05/03/2026'), false, 'a data efetiva não entra no arquivo exportado nesta entrega');
    assert.doesNotMatch(tudo, /Data efetiva|2026-03-05/);
  });
});

describe('contrato da migration candidata (lida do arquivo; sem banco)', () => {
  const nomes = fs.readdirSync(MIGRATIONS).filter((n) => /^\d{3}_.*\.sql$/.test(n)).sort();
  const posteriores095 = nomes.filter((n) => n.slice(0, 3) > '095');
  const candidata = nomes.find((n) => n.slice(0, 3) > '095' && /funcionario_situacoes/.test(fs.readFileSync(path.join(MIGRATIONS, n), 'utf8')));

  test('existe uma migration posterior à 095 que cria funcionario_situacoes', () => {
    assert.ok(candidata, 'migration candidata ausente (nenhum arquivo posterior à 095 cria funcionario_situacoes)');
  });

  test('a numeração é contígua à 095 (096 ou, se a LGPD-3 integrar antes, 097) e não reutiliza a 088', () => {
    assert.ok(candidata, 'migration candidata ausente');
    const numero = Number(candidata.slice(0, 3));
    assert.ok(numero >= 96 && numero <= 97, `número inesperado: ${candidata}`);
    const anteriores = nomes.filter((n) => n.slice(0, 3) < candidata.slice(0, 3)).map((n) => n.slice(0, 3));
    assert.equal(anteriores.at(-1), String(numero - 1).padStart(3, '0'), 'sem lacuna antes da candidata');
    assert.equal(nomes.some((n) => n.startsWith('088_')), false);
    assert.equal(posteriores095.filter((n) => /funcionario_situacoes/.test(fs.readFileSync(path.join(MIGRATIONS, n), 'utf8'))).length, 1);
  });

  test('o manifesto de checksums tem a entrada da candidata com o SHA-256 do arquivo e lista exatamente os arquivos do diretório', () => {
    assert.ok(candidata, 'migration candidata ausente');
    const manifesto = JSON.parse(fs.readFileSync(path.join(MIGRATIONS, 'checksums.json'), 'utf8')).migrations;
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(MIGRATIONS, candidata))).digest('hex');
    assert.equal(manifesto[candidata], sha);
    assert.deepEqual(Object.keys(manifesto).sort(), nomes);
  });

  test('é aditiva: cria só a tabela nova, sem backfill, sem permissão e sem tocar em tabela existente', () => {
    assert.ok(candidata, 'migration candidata ausente');
    const sql = semComentarios(fs.readFileSync(path.join(MIGRATIONS, candidata), 'utf8'));
    assert.match(sql, /CREATE\s+TABLE\s+funcionario_situacoes\b/i);
    assert.doesNotMatch(sql, /\bDROP\s+(TABLE|COLUMN|CONSTRAINT)\b/i);
    assert.doesNotMatch(sql, /\bALTER\s+TABLE\s+(?!funcionario_situacoes\b)/i);
    // O gatilho de imutabilidade tem de citar `BEFORE UPDATE OR DELETE`; o que não pode existir é a instrução UPDATE <tabela> SET.
    assert.doesNotMatch(sql, /\bUPDATE\s+\w+\s+SET\b/i);
    assert.doesNotMatch(sql, /\bDELETE\s+FROM\b/i);
    assert.doesNotMatch(sql, /\bINSERT\s+INTO\b/i, 'sem backfill, sem ação, sem permissão: a tabela nasce vazia');
    assert.doesNotMatch(sql, /\bacoes\b|\bperfis?\b|permiss/i);
  });

  test('a tabela só tem as colunas do contrato: nada de motivo, descrição, observação, previsão ou conflito', () => {
    assert.ok(candidata, 'migration candidata ausente');
    const sql = semComentarios(fs.readFileSync(path.join(MIGRATIONS, candidata), 'utf8'));
    const corpo = sql.slice(sql.search(/CREATE\s+TABLE\s+funcionario_situacoes/i));
    const colunas = ['empresa_id', 'funcionario_id', 'situacao_anterior', 'situacao_nova', 'data_efetiva', 'registrado_por', 'registrado_em'];
    for (const c of colunas) assert.match(corpo, new RegExp(`\\b${c}\\b`), c);
    assert.doesNotMatch(corpo, /motivo|descricao|observacao|previsao|conflito|diagnostico|\bcid\b|inss/i);
  });

  test('imutável e isolada por empresa: gatilho contra UPDATE, DELETE e TRUNCATE; FKs compostas com a empresa', () => {
    assert.ok(candidata, 'migration candidata ausente');
    const sql = semComentarios(fs.readFileSync(path.join(MIGRATIONS, candidata), 'utf8'));
    assert.match(sql, /CREATE\s+TRIGGER[\s\S]*?(UPDATE|DELETE)[\s\S]*?funcionario_situacoes/i);
    assert.match(sql, /TRUNCATE/i);
    assert.match(sql, /FOREIGN\s+KEY\s*\(\s*empresa_id\s*,\s*funcionario_id\s*\)\s*REFERENCES\s+funcionarios\s*\(\s*empresa_id\s*,\s*id\s*\)/i);
    assert.match(sql, /FOREIGN\s+KEY\s*\(\s*empresa_id\s*,\s*registrado_por\s*\)\s*REFERENCES\s+usuarios\s*\(\s*empresa_id\s*,\s*id\s*\)/i);
  });
});
