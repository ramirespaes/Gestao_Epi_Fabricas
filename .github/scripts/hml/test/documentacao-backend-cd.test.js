'use strict';
// A documentação da Etapa 1 do CD do backend precisa dizer o que existe, o que NÃO foi ativado e o que falta,
// com os nomes reais dos arquivos, variáveis e literais do código.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '../../../..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const doc = () => ler('docs/sistema/publicacao-homologacao-componentes.md');
const secao = () => {
  const d = doc();
  const i = d.indexOf('## Protocolo v2 e pedido do backend');
  return i < 0 ? '' : d.slice(i).split('\n## ')[0];
};

describe('documentação da Etapa 1 do CD do backend', () => {
  test('a seção existe e descreve o protocolo v2, o escopo e o prefixo do backend', () => {
    const s = secao();
    assert.ok(s.length > 0, 'seção "Protocolo v2 e pedido do backend" ausente (RED esperado)');
    for (const termo of ['pedido v2', 'escopo', 'frontend', 'backend', 'hml-backend/', 'ESCOPO_DIVERGENTE', 'protocolo.js', 'publicar.js']) assert.ok(s.includes(termo), `falta: ${termo}`);
  });
  test('cita o workflow, o environment, o interruptor, a role e a confirmação com os nomes reais do código', () => {
    const s = secao();
    for (const termo of ['deploy-hml-backend.yml', 'homologacao-backend', 'HML_BACKEND_PUBLICACAO_HABILITADA', 'HML_BACKEND_AWS_ROLE_ARN', 'HOMOLOGACAO-BACKEND']) {
      assert.ok(s.includes(termo), `falta: ${termo}`);
      assert.ok(ler('.github/workflows/deploy-hml-backend.yml').includes(termo) || ler('deploy/hml/cd/publicar.js').includes(termo), `${termo} não existe no código`);
    }
  });
  test('diz com todas as letras o que NÃO foi feito: agente, instalador, coordenação, AWS e GitHub', () => {
    const s = secao();
    assert.match(s, /COORDENACAO_NAO_HOMOLOGADA/);
    assert.match(s, /nenhum agente lê/i);
    assert.match(s, /não foi criado|não foi configurado|não está configurado|ainda não existe/i);
    assert.match(s, /Etapa 2/);
    assert.match(s, /autorização cruzada|uma aprovação de frontend nunca/i);
  });
  test('lista as pendências que dependem de autorização: environment, revisores, role, variáveis e política do bucket', () => {
    const s = secao();
    for (const termo of ['revisor', 'role', 'variáve', 'bucket']) assert.match(s, new RegExp(termo, 'i'), termo);
  });
  test('a tabela de componentes cita o protocolo e o workflow do backend', () => {
    const tabela = doc().split('## Componentes')[1].split('\n## ')[0];
    assert.match(tabela, /`cd\/protocolo\.js`/);
    assert.match(tabela, /`cd\/publicar\.js`/);
    assert.match(tabela, /deploy-hml-backend\.yml/);
  });
});
