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
    // 3B-2B-3B: o código sai de um ponto único (naoHomologada), usado pelas duas guardas anteriores à âncora.
    assert.match(ler('deploy/hml/instalador/instalar-release.js'), /const naoHomologada = \(mensagem\) => erro\('COORDENACAO_NAO_HOMOLOGADA', mensagem\);/);
    assert.match(ler('deploy/hml/instalador/nucleo.js'), /'COORDENACAO_NAO_HOMOLOGADA'/);
  });
  test('3B-2B-3B: só instalar segue para a conferência do guardião; reverter e a linha de comando seguem bloqueados, e uma função qualquer é recusada', async () => {
    const I = require(path.join(RAIZ, 'deploy/hml/instalador/instalar-release'));
    const os = require('node:os');
    const base = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'bloqueado-3b-'));
    try {
      const config = { raizesPersistentes: [], componentes: { backend: { tipo: 'backend', base, nome: 'backend', saude: { url: 'http://127.0.0.1:9/api/health' }, reinicio: { comando: ['/bin/true'] }, processo: { pidComando: ['/bin/true'] } } } };
      const livre = async () => ({ situacao: 'LIVRE', origem: 'qualquer', consultadoEm: new Date().toISOString() });
      const deps = { consultarCoordenacao: livre, reiniciar: async () => {}, verificarSaude: async () => ({ ok: true }), identificarProcesso: async () => ({ pid: 2, cwd: base }) };
      await assert.rejects(I.reverter({ config, componente: 'backend', deps }), (e) => e.codigo === 'COORDENACAO_NAO_HOMOLOGADA');
      for (const op of ['instalar', 'reverter']) assert.throws(() => N.verificarOperacaoNaInterface('backend', op, 'cli'), (e) => e.codigo === 'COORDENACAO_NAO_HOMOLOGADA', op);
      assert.equal(provedorHomologado(livre), false);
      assert.deepEqual(fs.readdirSync(base), [], 'nada criado');
    } finally {
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
  // 4C (D-H1): a adoção é uma operação separada, que só cria a primeira release; ela não abre outro caminho para
  // instalar sobre uma release em uso, reiniciar ou reverter o backend.
  test('4C (D-H1): a adoção não abre caminho para instalar, reiniciar ou reverter o backend; a política da linha de comando não muda', () => {
    assert.deepEqual([...N.POLITICA_DE_COMPONENTES.backend.cli].sort(), ['identificar', 'reconciliar'], 'adotar não entra na linha de comando do instalador');
    const cli = ler('deploy/hml/instalador/adotar-backend.js');
    assert.match(cli, /I\.adotarBaselineDoBackend\(/);
    assert.doesNotMatch(cli, /\.instalar\(|\.reverter\(|\.reconciliar\(|consultarCoordenacao|reiniciar|permitir|semAutenticacao|semComprovacao|resolverEstadoCritico/);
    const fonte = ler('deploy/hml/instalador/instalar-release.js');
    const adocao = fonte.slice(fonte.indexOf('async function adotarBaselineDoBackend('), fonte.indexOf('async function identificar('));
    assert.doesNotMatch(adocao, /reiniciarEComprovar|comprovarExecucao|\.reiniciar\(|identificarProcesso|verificarSaude|consultarCoordenacao|avaliarPreCondicoes|naoHomologada|provedorHomologado/);
    assert.match(adocao, /const depsDaAdocao = \{ executar: deps\.executar \|\| executarComando, usuario: deps\.usuario \};/, 'só a instalação de dependências segue adiante');
    assert.match(fonte, /const naoHomologada = \(mensagem\) => erro\('COORDENACAO_NAO_HOMOLOGADA', mensagem\);/);
    assert.equal((fonte.match(/erro\('COORDENACAO_NAO_HOMOLOGADA'/g) || []).length, 1, 'continua um único ponto de lançamento');
  });
  // 4C (D-H1, opção 1): a confirmação da release adotada só lê (processo, PID, saúde) e grava o estado uma vez.
  test('4C (D-H1): a confirmação da adoção não reinicia, não instala, não executa comandos, não consulta coordenação nem migrations', () => {
    const fonte = ler('deploy/hml/instalador/instalar-release.js');
    const inicio = fonte.indexOf('async function confirmarBaselineAdotada(');
    assert.ok(inicio > 0);
    const confirmacao = fonte.slice(inicio, fonte.indexOf('// ------------------------------------------------------------ linha de comando', inicio));
    assert.doesNotMatch(confirmacao, /reiniciarEComprovar|\.reiniciar\(|preparar\(|trocarAtual|trocarAnterior|removerAtual|avaliarPreCondicoes|lerObservado|consultarCoordenacao|\.executar\(|naoHomologada|migrat/);
    assert.match(confirmacao, /comprovarExecucao\(\{ ctx, deps, alvoRotulo: rotulo, procAntes: null/);
    assert.equal((confirmacao.match(/gravarEstado\(/g) || []).length, 1, 'uma única escrita do estado');
    assert.doesNotMatch(ler('deploy/hml/instalador/adotar-backend.js'), /\.instalar\(|\.reverter\(|reiniciar|consultarCoordenacao/);
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
