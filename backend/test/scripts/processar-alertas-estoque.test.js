'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const svc = require('../../src/services/alerta-disponibilidade.service');
const { dataOperacional } = require('../../src/utils/data-operacional');

/**
 * 12G-6 — o processador do aviso de disponibilidade roda por cron externo
 * (script versionado), nunca por timer dentro do processo da API. A execução
 * contra PostgreSQL real está em test/integracao/alerta-disponibilidade.integration.js.
 */

const RAIZ = path.join(__dirname, '..', '..');
const script = () => exigirModulo('scripts/processar-alertas-estoque');

describe('script processar-alertas-estoque', () => {
  test('processa com a data operacional de São Paulo do instante da execução e o serviço de e-mail recebido', async (t) => {
    const chamadas = [];
    t.mock.method(svc, 'processarVencidos', async (pool, opcoes) => {
      chamadas.push({ pool, opcoes });
      return { processados: [{ estado: 'ENVIADO' }, { estado: 'DESCARTADO' }, { estado: 'ENVIADO' }], abandonados: 1 };
    });
    const pool = {};
    const servicoEmail = { enviarAguardando: async () => ({ estado: 'ENVIADO' }) };
    const agora = new Date('2026-10-04T02:30:00.000Z');
    const linhas = [];
    const codigo = await script().executar({ pool, servicoEmail, agora, saida: { log: (...a) => linhas.push(a), error: (...a) => linhas.push(a) } });
    assert.equal(codigo, script().SAIDAS.OK);
    assert.equal(chamadas.length, 1);
    assert.equal(chamadas[0].pool, pool);
    assert.equal(chamadas[0].opcoes.servicoEmail, servicoEmail);
    assert.equal(chamadas[0].opcoes.agora, agora);
    assert.equal(chamadas[0].opcoes.hoje, dataOperacional(agora));
    assert.equal(chamadas[0].opcoes.hoje, '2026-10-03', 'a data é a de São Paulo, não a UTC');
    const registro = JSON.stringify(linhas);
    assert.match(registro, /"ENVIADO":2/);
    assert.match(registro, /"DESCARTADO":1/);
    assert.match(registro, /"abandonados":1/);
  });

  test('a saída do script é só contagem: nunca e-mail, nome ou identificador de item', async (t) => {
    t.mock.method(svc, 'processarVencidos', async () => ({
      processados: [{ agendamentoId: '9', empresaId: 3, estado: 'ENVIADO', codigo: null }], abandonados: 0,
    }));
    const linhas = [];
    await script().executar({ pool: {}, servicoEmail: { enviarAguardando: async () => ({}) }, agora: new Date(), saida: { log: (...a) => linhas.push(a), error: (...a) => linhas.push(a) } });
    assert.doesNotMatch(JSON.stringify(linhas), /@|agendamentoId|empresaId/);
  });

  test('códigos de saída e script npm próprio, com o dotenv como os demais scripts de operação', () => {
    assert.deepEqual(script().SAIDAS, { OK: 0, ERRO: 1 });
    const { scripts } = JSON.parse(fs.readFileSync(path.join(RAIZ, 'package.json'), 'utf8'));
    assert.equal(scripts['alertas:processar'], 'node --require dotenv/config scripts/processar-alertas-estoque.js');
  });

  test('a API nunca processa os alertas sozinha: nenhum timer no código da aplicação e o servidor não carrega o processador', () => {
    const arquivos = [];
    const varrer = (dir) => {
      for (const nome of fs.readdirSync(dir, { withFileTypes: true })) {
        const caminho = path.join(dir, nome.name);
        if (nome.isDirectory()) varrer(caminho);
        else if (nome.name.endsWith('.js')) arquivos.push(caminho);
      }
    };
    varrer(path.join(RAIZ, 'src'));
    for (const arquivo of arquivos) {
      assert.doesNotMatch(fs.readFileSync(arquivo, 'utf8'), /\bsetInterval\s*\(/, path.relative(RAIZ, arquivo));
    }
    for (const arquivo of ['src/app.js', 'src/server.js']) {
      assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, arquivo), 'utf8'), /processar-alertas-estoque|processarVencidos|alerta-disponibilidade/, arquivo);
    }
  });
});
