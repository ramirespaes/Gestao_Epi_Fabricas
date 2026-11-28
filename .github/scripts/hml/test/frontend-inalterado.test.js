'use strict';
// Etapa 2B: o CD do frontend, o instalador, a coordenação e os workflows não mudam. Os hashes são os da main em 35a2fb4.
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const RAIZ = path.resolve(__dirname, '../../../..');
const PROTEGIDOS = {
  'deploy/hml/cd/agente.js': 'a45965b3652ad206f82828f925eadf55fb6b20b98a4011d5a14355ea16338d1c',
  'deploy/hml/cd/protocolo.js': '759676fa891812e40d7e3720d0dc12b8b0bd7d9204c6c1ea8a70d067e7eb9b58',
  'deploy/hml/cd/publicar.js': '6b0f84c70827fa75c3caecb4ad70623a06ed149c66f2d19d3ce2fa53c4eec92a',
  'deploy/hml/cd/s3.js': 'd62e413f70a0fc76fff97d5e3e3154add8aa810b2a2fa09be358a6ef8239335d',
  'deploy/hml/cd/iam-agente.modelo.json': '0b58d02217ef3acf6552fa69ea7ac940e327fa7fea6c1432223501b38f5c7926',
  'deploy/hml/cd/iam-confianca.modelo.json': 'c2b8e3a80f819c5361e25b8f8ff6b1b5e20a26ec76014762d2ad64d8738787d2',
  'deploy/hml/cd/iam-publicador.modelo.json': '7116581dd561f30e2e2bf9d57e9f46fd31407c0d52e7f3f1a4737025e84bb298',
  'deploy/hml/cd/s3-politica.modelo.json': 'ce87a8822db428c15db1ba2029b76c2824423f19e444620a34900245881a609d',
  'deploy/hml/cd/agente.config.exemplo.json': '2fdfb589a3b8f6d844979f1687272b63852ce5c803dbe66f7b9afee613e64c1c',
  'deploy/hml/instalador/ancora.js': '8aef3e40d69dc38b1ad0e59dd4819f071e4ad307f878888ea4b1d6d611ff8b30',
  'deploy/hml/instalador/compatibilidade.js': 'ec9e0888aa9f065cb1aa34606efc64b7c8a97e41f29ea06cc9cc2f39d31c2857',
  // 3B-2B-3B (D1): coordenacao.js e instalar-release.js mudaram só pela homologação do provedor do guardião.
  // 4C (D-H1 e D-H2): instalar-release.js mudou só pela adoção da primeira release do backend, pela confirmação dela e
  // pelo leitor da identidade do serviço.
  'deploy/hml/instalador/coordenacao.js': '6db83ae382318b0a6f415de46de11b900f42d18a6b28387e9c99ca4d1f8db404',
  'deploy/hml/instalador/erros.js': 'fed004c3471a32d1000b98ce070a78d22e8d5a43e601dc9b873f60216cc4b3ac',
  // Correção A (pedido 45240585273-1): instalar-release.js mudou só pela selagem do node_modules no preparo.
  // Correção B (B1): mudou só pela confirmação da recuperação sem reinício e pela leitura dessa confirmação.
  'deploy/hml/instalador/instalar-release.js': 'a6ea30d55d8a858303fa93a4502b101f05c94de9e01f753ba960a97a47d3fff3',
  'deploy/hml/instalador/nucleo.js': '144a1194d9a7e2fc4b8c0b73dfc7afae3b4a5a267efe122736788b3e2f28d716',
  'deploy/hml/empacotar-backend.js': 'cc1a008648508df30d91f326facdffc3b18651dcbddb5bd33d875fb05f2fee75',
  // S6505: ci.yml mudou só pelo --ignore-scripts nas duas instalações (ci-ignore-scripts.test.js).
  '.github/workflows/ci.yml': '719c1b3e39c41860fae89c43276ce4a4e0a6575be57a0b98132725f2880cc345',
  '.github/workflows/deploy-hml-backend.yml': 'f1f3afb14770541fa86dfb7f1797fdf15ab30ee257f87a8afabade93ed52b0e1',
  // Etapas 3B-3/3B-4: ganhou só o job final "conjunto" (prepara e confere o backend, sem publicar). Todo o texto
  // anterior a ele continua com o hash 1e4a6bf8…, provado em workflow-unificado.test.js.
  // S8264: actions: read saiu do topo e foi para o job validar; desfeita essa mudança, o hash 1e4a6bf8… se mantém.
  '.github/workflows/deploy-hml.yml': '41fad287387070e2f446700ce680998d510d790c8cdc97e207d112b025bfaddf',
};
const sha = (rel) => crypto.createHash('sha256').update(fs.readFileSync(path.join(RAIZ, rel))).digest('hex');

describe('preservação do frontend e das proteções do backend', () => {
  for (const [rel, esperado] of Object.entries(PROTEGIDOS)) {
    test(`hash inalterado: ${rel}`, () => assert.equal(sha(rel), esperado));
  }

  test('o agente do frontend continua recusando o componente backend', () => {
    const { validarConfiguracao } = require(path.join(RAIZ, 'deploy/hml/cd/agente'));
    assert.throws(() => validarConfiguracao({ habilitado: false }), (e) => e.codigo === 'AGENTE_DESABILITADO');
  });

  test('nenhum provedor de coordenação foi homologado e o atestado manual não libera o backend', () => {
    const C = require(path.join(RAIZ, 'deploy/hml/instalador/coordenacao'));
    assert.equal(C.provedorHomologado(async () => ({ situacao: 'LIVRE', origem: 'x', consultadoEm: new Date().toISOString() })), false);
    const r = C.avaliarCoordenacao({ tipo: 'backend', estado: undefined, atestado: true });
    assert.equal(r.ok, false);
    assert.equal(r.bloqueio.codigo, 'COORDENACAO_NAO_CONFIRMADA');
    assert.throws(() => C.homologarProvedorParaTeste(() => {}), /só existe em testes/);
  });

  test('o workflow do backend continua inerte: só dispara manualmente e o interruptor próprio é exigido', () => {
    const yml = fs.readFileSync(path.join(RAIZ, '.github/workflows/deploy-hml-backend.yml'), 'utf8');
    assert.match(yml, /workflow_dispatch:/);
    assert.doesNotMatch(yml, /^\s*(push|pull_request|schedule):/m);
    assert.match(yml, /vars\.HML_BACKEND_PUBLICACAO_HABILITADA == 'true'/);
    assert.match(yml, /environment: homologacao-backend/);
  });

  test('os arquivos da Etapa 2B não aparecem nos workflows nem nos modelos do frontend', () => {
    for (const rel of ['.github/workflows/deploy-hml.yml', 'deploy/hml/cd/iam-publicador.modelo.json', 'deploy/hml/cd/iam-agente.modelo.json']) {
      assert.doesNotMatch(fs.readFileSync(path.join(RAIZ, rel), 'utf8'), /hml-backend|agente-backend|precondicao-migrations/, rel);
    }
  });
});
