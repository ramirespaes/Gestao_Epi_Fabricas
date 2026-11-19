'use strict';
// Etapa 1 do CD do backend só ENTREGA O PEDIDO. Estas provas garantem que nada passou a executá-lo: o agente continua
// só de frontend, o instalador continua recusando o backend e o papel do agente não enxerga o prefixo do backend.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '../../../..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const { avaliarCoordenacao, consultaPadrao, provedorHomologado } = require(path.join(RAIZ, 'deploy/hml/instalador/coordenacao'));
const N = require(path.join(RAIZ, 'deploy/hml/instalador/nucleo'));

describe('Etapa 1: o backend continua bloqueado no instalador', () => {
  test('a política por componente ainda bloqueia instalar e reverter o backend com COORDENACAO_NAO_HOMOLOGADA', () => {
    const backend = N.POLITICA_DE_COMPONENTES.backend;
    assert.deepEqual([...backend.cli].sort(), ['identificar', 'reconciliar']);
    assert.match(backend.bloqueios.instalar, /bloqueado/);
    assert.match(backend.bloqueios.reverter, /bloqueado/);
    assert.match(ler('deploy/hml/instalador/instalar-release.js'), /throw erro\('COORDENACAO_NAO_HOMOLOGADA'/);
    assert.match(ler('deploy/hml/instalador/nucleo.js'), /'COORDENACAO_NAO_HOMOLOGADA'/);
  });
  test('nenhum provedor de coordenação está homologado: nem o padrão, nem um injetado que declare LIVRE', () => {
    assert.equal(provedorHomologado(consultaPadrao), false);
    assert.equal(provedorHomologado(async () => ({ situacao: 'LIVRE', origem: 'teste', consultadoEm: new Date().toISOString() })), false);
    assert.equal(provedorHomologado(undefined), false);
  });
  test('o provedor padrão continua devolvendo DESCONHECIDO, que bloqueia a troca do backend', async () => {
    const estado = await consultaPadrao();
    assert.equal(estado.situacao, 'DESCONHECIDO');
    assert.match(estado.origem, /nenhuma trava do D-ORF-6 homologada/);
    const r = avaliarCoordenacao({ tipo: 'backend', estado });
    assert.equal(r.ok, false);
    assert.equal(r.bloqueio.codigo, 'COORDENACAO_NAO_CONFIRMADA');
  });
  test('o código do instalador não registra provedor homologado fora da função de teste', () => {
    const fonte = ler('deploy/hml/instalador/coordenacao.js');
    assert.equal((fonte.match(/PROVEDORES_HOMOLOGADOS\.add\(/g) || []).length, 1, 'o único registro é o de homologarProvedorParaTeste');
    assert.match(fonte, /function homologarProvedorParaTeste[\s\S]{0,200}PROVEDORES_HOMOLOGADOS\.add\(/);
  });
});

describe('Etapa 1: o agente atual não executa pedidos do backend', () => {
  const agente = ler('deploy/hml/cd/agente.js');
  test('o agente continua só de frontend: exige exatamente painel,portal estáticos', () => {
    assert.match(agente, /join\(','\) === 'painel,portal'/);
    assert.match(agente, /tipo === 'estatico'/);
  });
  test('o agente não conhece o backend: sem prefixo hml-backend, sem escopo, sem componente backend', () => {
    assert.doesNotMatch(agente, /hml-backend|escopo|ESCOPOS/);
    assert.doesNotMatch(agente, /componentes\.backend|'backend'/);
  });
  test('o agente valida o pedido sem declarar escopo, então um pedido de backend seria recusado por ESCOPO_DIVERGENTE', () => {
    assert.match(agente, /P\.validarPedido\(pedido, agora\(\)\)/);
    assert.doesNotMatch(agente, /validarPedido\([^)]*escopo/);
  });
  test('a fila do agente continua em hml/pedidos/ (o cliente S3 padrão não lê o prefixo do backend)', () => {
    assert.match(ler('deploy/hml/cd/s3.js'), /prefixo = 'hml'/);
  });
});

describe('Etapa 1: separação de privilégios dos modelos de IAM', () => {
  test('o papel do agente e o do publicador do frontend não alcançam hml-backend/', () => {
    for (const arq of ['deploy/hml/cd/iam-agente.modelo.json', 'deploy/hml/cd/iam-publicador.modelo.json', 'deploy/hml/cd/s3-politica.modelo.json']) {
      assert.doesNotMatch(ler(arq), /hml-backend/, arq);
    }
  });
  test('a confiança OIDC do frontend continua restrita ao environment homologacao (não ao do backend)', () => {
    const trust = ler('deploy/hml/cd/iam-confianca.modelo.json');
    assert.match(trust, /environment:homologacao"/);
    assert.doesNotMatch(trust, /homologacao-backend/);
  });
});
