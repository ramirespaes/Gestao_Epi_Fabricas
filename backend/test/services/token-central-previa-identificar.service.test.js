'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const service = require('../../src/services/token-central.service');

/**
 * K7 — Consulta real da prévia do Totem (RED): serviço sem banco, com um cliente falso que registra TODA instrução. Prova:
 * identificação, GHE e catálogo numa transação `READ ONLY REPEATABLE READ` (o banco proíbe escrita ali); a ÚNICA escrita é uma linha de
 * auditoria numa transação à parte, sem CPF, matrícula ou valor digitado; 404 uniforme; nenhum repositório de escrita é importado.
 * Os identificadores abaixo são fictícios.
 */

const EMPRESA = 7;
const ATOR = 31;
const CPF_FICTICIO = '12345678901';
const MATRICULA_FICTICIA = 'MX-4242';

const exigir = () => assert.equal(typeof service.previaIdentificar, 'function', 'RED K7: previaIdentificar ainda não existe (comportamento ausente)');

function clienteFalso({ funcionario = { id: 55, nome: '  Maria   Souza Fictícia ' }, ghe = { codigo: 'GHE-102', descricao: 'Soldagem', ativo: true }, gheRef = { ghe_id: 9, ghe_ativo: true }, materiais = [], falharAuditoria = false } = {}) {
  const sql = [];
  const parametros = [];
  const executor = {
    async query(texto, params) {
      const t = String(texto).replace(/\s+/g, ' ').trim();
      sql.push(t);
      parametros.push(params);
      if (/^(BEGIN|COMMIT|ROLLBACK)/.test(t)) return { rows: [] };
      if (/FROM funcionarios WHERE empresa_id = \$1 AND (cpf|matricula) = \$2/.test(t)) return { rows: funcionario === null ? [] : [funcionario] };
      if (/g\.codigo/.test(t)) return { rows: ghe === null ? [] : [ghe] };
      if (/AS ghe_id/.test(t)) return { rows: gheRef === null ? [] : [gheRef] };
      if (/FROM materiais m/.test(t)) return { rows: materiais };
      if (/INSERT INTO logs_auditoria/.test(t)) {
        if (falharAuditoria) throw new Error('falha simulada da auditoria');
        return { rows: [{ id: 1, criado_em: new Date() }] };
      }
      throw new Error(`instrução inesperada no teste: ${t.slice(0, 120)}`);
    },
    release() {},
  };
  return { sql, parametros, pool: { connect: async () => executor } };
}

const MATERIAL = { id: 11, nome: 'Botina de Segurança', unidade: 'PAR', categoria: 'EPI', grupo_protecao: 'Proteção dos pés', tipo: 'Botina de Segurança', tipo_material_id: 1, exige_tamanho: true, tamanhos: ['40', '41'] };
const chamar = (tipo, valor, cliente) => service.previaIdentificar(cliente.pool, { empresaId: EMPRESA, atorId: ATOR, tipo, valor, ip: '127.0.0.1', dispositivo: 'Navegador de Teste' });

describe('K7 — serviço previaIdentificar', () => {
  test('K7-S1 — por matrícula: identifica, traz GHE e catálogo reais e devolve só primeiro nome, GHE e catálogo', async () => {
    exigir();
    const c = clienteFalso({ materiais: [MATERIAL] });
    const r = await chamar('MATRICULA', MATRICULA_FICTICIA, c);
    assert.deepEqual(Object.keys(r).sort(), ['catalogo', 'funcionario', 'ghe']);
    assert.deepEqual(r.funcionario, { primeiroNome: 'Maria' });
    assert.deepEqual(r.ghe, { codigo: 'GHE-102', descricao: 'Soldagem', ativo: true });
    assert.equal(r.catalogo.estado, 'OK');
    assert.equal(r.catalogo.total, 1);
    assert.equal(r.catalogo.materiais[0].nome, 'Botina de Segurança');
    const texto = JSON.stringify(r);
    for (const proibido of [MATRICULA_FICTICIA, CPF_FICTICIO, 'Souza', 'Fictícia', '"id":55']) assert.equal(texto.includes(proibido), false, proibido);
  });

  test('K7-S2 — por CPF: a identificação usa o CPF só como parâmetro da consulta exata', async () => {
    exigir();
    const c = clienteFalso({ materiais: [MATERIAL] });
    const r = await chamar('CPF', CPF_FICTICIO, c);
    assert.equal(r.funcionario.primeiroNome, 'Maria');
    const i = c.sql.findIndex((s) => /FROM funcionarios WHERE empresa_id = \$1 AND cpf = \$2/.test(s));
    assert.ok(i >= 0);
    assert.deepEqual(c.parametros[i], [EMPRESA, CPF_FICTICIO]);
    assert.equal(c.sql.some((s) => s.includes(CPF_FICTICIO)), false, 'o CPF nunca é concatenado ao SQL');
  });

  test('K7-S3 — identificação, GHE e catálogo ficam numa só transação READ ONLY REPEATABLE READ; a auditoria vem DEPOIS, em outra', async () => {
    exigir();
    const c = clienteFalso({ materiais: [MATERIAL] });
    await chamar('MATRICULA', MATRICULA_FICTICIA, c);
    assert.equal(c.sql[0], 'BEGIN READ ONLY ISOLATION LEVEL REPEATABLE READ');
    const fim = c.sql.indexOf('COMMIT');
    assert.ok(fim > 0);
    const bloco = c.sql.slice(1, fim);
    assert.ok(bloco.length >= 3, 'identificação, GHE do cadastro e catálogo');
    for (const s of bloco) assert.match(s, /^SELECT\b/, `só leitura no bloco READ ONLY: ${s.slice(0, 80)}`);
    assert.ok(bloco.some((s) => /g\.codigo/.test(s)), 'o GHE (código, descrição, situação) é lido no MESMO bloco do catálogo');
    assert.ok(bloco.some((s) => /FROM materiais m/.test(s)));
    const resto = c.sql.slice(fim + 1);
    assert.deepEqual(resto.filter((s) => !/^(BEGIN|COMMIT|ROLLBACK)/.test(s)).map((s) => s.slice(0, 26)), ['INSERT INTO logs_auditoria']);
    assert.equal(c.sql.filter((s) => /^(INSERT|UPDATE|DELETE|TRUNCATE|ALTER|CREATE|DROP)/.test(s)).length, 1, 'uma única escrita em toda a operação');
  });

  test('K7-S4 — a auditoria TOKEN_PREVIA_CONSULTADA leva só ids, tipo e contagens: nunca CPF, matrícula, valor, nome ou GHE', async () => {
    exigir();
    const c = clienteFalso({ materiais: [MATERIAL] });
    await chamar('CPF', CPF_FICTICIO, c);
    const i = c.sql.findIndex((s) => /INSERT INTO logs_auditoria/.test(s));
    const p = c.parametros[i];
    assert.deepEqual([p[0], p[1], p[2], p[3]], [EMPRESA, ATOR, 'TOKEN_PREVIA_CONSULTADA', '55']);
    assert.deepEqual(p[7], { tipoIdentificador: 'CPF', encontrado: true, estado: 'OK', total: 1 });
    const tudo = JSON.stringify(p);
    for (const proibido of [CPF_FICTICIO, MATRICULA_FICTICIA, 'Maria', 'Souza', 'Soldagem', 'GHE-102']) assert.equal(tudo.includes(proibido), false, proibido);
  });

  test('K7-S5 — não identificado: 404 uniforme, auditado sem valor e sem referência; inexistente, inativo e outra empresa são indistinguíveis', async () => {
    exigir();
    for (const tipo of ['CPF', 'MATRICULA']) {
      const c = clienteFalso({ funcionario: null });
      const valor = tipo === 'CPF' ? CPF_FICTICIO : MATRICULA_FICTICIA;
      await assert.rejects(chamar(tipo, valor, c), (e) => {
        assert.equal(e.status ?? e.statusCode, 404);
        assert.equal(e.codigo ?? e.code, 'FUNCIONARIO_NAO_IDENTIFICADO');
        assert.equal(JSON.stringify({ m: e.message, c: e.codigo }).includes(valor), false, 'a mensagem não ecoa o identificador');
        return true;
      });
      const i = c.sql.findIndex((s) => /INSERT INTO logs_auditoria/.test(s));
      assert.ok(i >= 0, 'a tentativa não identificada também é auditada');
      assert.equal(c.parametros[i][3], null, 'sem referência de funcionário');
      assert.deepEqual(c.parametros[i][7], { tipoIdentificador: tipo, encontrado: false });
      assert.equal(JSON.stringify(c.parametros[i]).includes(valor), false);
    }
  });

  test('K7-S6 — sem GHE, GHE inativo e sem materiais seguem as regras reais do catálogo; o GHE é null só quando não há GHE', async () => {
    exigir();
    const semGhe = await chamar('MATRICULA', MATRICULA_FICTICIA, clienteFalso({ gheRef: { ghe_id: null, ghe_ativo: null }, ghe: null }));
    assert.equal(semGhe.catalogo.estado, 'SEM_GHE');
    assert.equal(semGhe.ghe, null);
    const inativo = await chamar('MATRICULA', MATRICULA_FICTICIA, clienteFalso({ gheRef: { ghe_id: 9, ghe_ativo: false }, ghe: { codigo: null, descricao: 'Antigo', ativo: false } }));
    assert.equal(inativo.catalogo.estado, 'GHE_INATIVO');
    assert.deepEqual(inativo.ghe, { codigo: null, descricao: 'Antigo', ativo: false });
    const vazio = await chamar('MATRICULA', MATRICULA_FICTICIA, clienteFalso({ materiais: [] }));
    assert.equal(vazio.catalogo.estado, 'SEM_MATERIAIS');
  });

  test('K7-S7 — se a auditoria falha, nada é devolvido (sem auditoria não há consulta)', async () => {
    exigir();
    await assert.rejects(chamar('MATRICULA', MATRICULA_FICTICIA, clienteFalso({ materiais: [MATERIAL], falharAuditoria: true })), /auditoria/);
  });

  test('K7-S8 — entrada inválida do serviço é recusada antes de qualquer consulta', async () => {
    exigir();
    const c = clienteFalso();
    await assert.rejects(service.previaIdentificar(c.pool, { empresaId: 0, atorId: ATOR, tipo: 'CPF', valor: CPF_FICTICIO }), TypeError);
    await assert.rejects(service.previaIdentificar(c.pool, { empresaId: EMPRESA, atorId: ATOR, tipo: 'NOME', valor: 'x' }), TypeError);
    assert.deepEqual(c.sql, []);
  });

  test('K7-S9 — estático: o serviço não importa nenhum repositório de escrita operacional (solicitação, atendimento, entrega, estoque, funcionário)', () => {
    const codigo = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'services', 'token-central.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
    const requeridos = [...codigo.matchAll(/require\('([^']+)'\)/g)].map((m) => m[1]).sort();
    assert.deepEqual(requeridos, [
      '../errors/HttpError', '../repositories/auditoria.repository', '../repositories/token-atendimento.repository', '../repositories/token-central.repository', './token-catalogo.service',
    ], 'só leitura (identificação, GHE, catálogo) e a auditoria');
    assert.doesNotMatch(codigo, /solicitacao|entrega|estoque|lote|numeracao|atendimentoRepo\.(inserir|encerrar|renovar|travar)|funcionarioRepo/i);
  });
});
