'use strict';

const { describe, test, beforeEach } = require('node:test');
const assert = require('node:assert/strict');

const EpiHttp = require('../js/api-http');
const P = require('../js/permissoes-efetivas');
const T = require('../js/atendimento-token');
const centralSchemas = require('../../backend/src/schemas/token-central.schema');
const dispositivoSchemas = require('../../backend/src/schemas/token-dispositivo.schema');
const fs = require('node:fs');
const path = require('node:path');

/**
 * Etapa H (frontend) — contratos da Central Administrativa do Atendimento Token (js/atendimento-token.js): caminhos e
 * corpos exatamente como o backend aceita, `fetch` injetado, nenhum campo de autoridade, validações iguais às do servidor,
 * modelos que recusam resposta fora do formato e capacidades vindas só das permissões reais.
 */

// As rotas e serviços do backend carregam a configuração do ambiente; o contrato é conferido pelo texto-fonte (constantes literais).
const fonteDoBackend = (rel) => fs.readFileSync(path.join(__dirname, '..', '..', 'backend', 'src', rel), 'utf8');
const constante = (rel, nome) => new RegExp(`const ${nome} = '([^']+)'`).exec(fonteDoBackend(rel))[1];

const BASE = 'http://localhost:3000/api';
const resposta = (status, corpo) => ({ status, ok: status >= 200 && status < 300, text: async () => (corpo === undefined ? '' : JSON.stringify(corpo)) });

let chamadas;
beforeEach(() => {
  chamadas = [];
  EpiHttp.configurar({
    baseUrl: BASE,
    fetch: async (url, opcoes) => {
      chamadas.push({ url, metodo: opcoes.method, credentials: opcoes.credentials, corpo: opcoes.body === undefined ? undefined : JSON.parse(opcoes.body) });
      return resposta(200, { status: 'ok' });
    },
  });
});
const ultima = () => chamadas[chamadas.length - 1];
const caminho = (c) => c.url.slice(BASE.length);

describe('rotas: caminho, método e corpo exatamente como o servidor aceita', () => {
  test('leituras: GET com a sessão do cookie e sem corpo', async () => {
    await T.acoes.visaoGeral();
    assert.deepEqual([caminho(ultima()), ultima().metodo, ultima().credentials, ultima().corpo], ['/atendimento-token/visao-geral', 'GET', 'include', undefined]);
    await T.acoes.listarDispositivos(2, 20);
    assert.equal(caminho(ultima()), '/atendimento-token/dispositivos?pagina=2&limite=20');
    await T.acoes.consultarDispositivo(7);
    assert.equal(caminho(ultima()), '/atendimento-token/dispositivos/7');
    await T.acoes.estadoAtivacao(7);
    assert.equal(caminho(ultima()), '/atendimento-token/dispositivos/7/ativacao');
    await T.acoes.listarRedes(1, 100);
    assert.equal(caminho(ultima()), '/atendimento-token/redes?pagina=1&limite=100');
    await T.acoes.previa(31);
    assert.equal(caminho(ultima()), '/atendimento-token/previa/catalogo?funcionarioId=31');
    assert.equal(chamadas.every((c) => c.metodo === 'GET' && c.corpo === undefined), true);
  });

  test('escritas: o corpo é exatamente o do contrato (vazio onde o servidor exige corpo vazio)', async () => {
    await T.acoes.cadastrarDispositivo({ nome: 'Tablet 1' });
    assert.deepEqual([ultima().metodo, caminho(ultima()), ultima().corpo], ['POST', '/atendimento-token/dispositivos', { nome: 'Tablet 1' }]);
    await T.acoes.editarDispositivo(4, { setor: null });
    assert.deepEqual([ultima().metodo, caminho(ultima()), ultima().corpo], ['PATCH', '/atendimento-token/dispositivos/4', { setor: null }]);
    await T.acoes.revogarDispositivo(4);
    assert.deepEqual([ultima().metodo, caminho(ultima()), ultima().corpo], ['POST', '/atendimento-token/dispositivos/4/revogar', {}]);
    await T.acoes.gerarAtivacao(4);
    assert.deepEqual([ultima().metodo, caminho(ultima()), ultima().corpo], ['POST', '/atendimento-token/dispositivos/4/ativacao', {}]);
    await T.acoes.cadastrarRede({ rede: '10.0.0.1' });
    assert.deepEqual([ultima().metodo, caminho(ultima()), ultima().corpo], ['POST', '/atendimento-token/redes', { rede: '10.0.0.1' }]);
    await T.acoes.desativarRede(9);
    assert.deepEqual([ultima().metodo, caminho(ultima()), ultima().corpo], ['POST', '/atendimento-token/redes/9/desativar', {}]);
  });

  test('identificador, página e limite inválidos são recusados ANTES da rede', () => {
    for (const ruim of [0, -1, 1.5, '3', null, undefined, NaN]) {
      assert.throws(() => T.acoes.consultarDispositivo(ruim), TypeError);
      assert.throws(() => T.acoes.revogarDispositivo(ruim), TypeError);
      assert.throws(() => T.acoes.estadoAtivacao(ruim), TypeError);
      assert.throws(() => T.acoes.gerarAtivacao(ruim), TypeError);
      assert.throws(() => T.acoes.desativarRede(ruim), TypeError);
      assert.throws(() => T.acoes.previa(ruim), TypeError);
    }
    assert.throws(() => T.acoes.listarDispositivos(0, 20), TypeError);
    assert.throws(() => T.acoes.listarDispositivos(1, 101), TypeError);
    assert.throws(() => T.acoes.listarRedes(1, 0), TypeError);
    assert.equal(chamadas.length, 0);
  });

  test('a busca de funcionário: termo aparado, até 100 pontos de código, sem controle; nunca CPF na URL', () => {
    for (const ruim of ['', '   ', 'a'.repeat(101), 'a\nb', null, undefined, 5]) assert.throws(() => T.acoes.buscarFuncionarios(ruim, 20), TypeError);
    assert.equal(chamadas.length, 0);
    T.acoes.buscarFuncionarios('  Ana  ', 20);
    assert.equal(caminho(ultima()), '/funcionarios?busca=Ana&pagina=1&limite=20');
  });

  test('nenhum corpo carrega empresa, ator, perfil, situação ou carimbo: o cliente HTTP recusaria e os corpos montados nunca os trazem', () => {
    const corpos = [
      T.formulario.corpoCriacao({ nome: 'A', unidade: 'U', setor: 'S', localInstalacao: 'L', fabricante: 'F', modelo: 'M', numeroSerie: 'N' }),
      T.formulario.corpoEdicao({ nome: 'A' }, { nome: 'B', unidade: 'X' }),
      T.rede.corpo({ rede: '10.0.0.1', descricao: 'Matriz' }),
    ];
    const proibidos = ['empresaId', 'empresa_id', 'atorId', 'perfil', 'criadoPor', 'revogadoPor', 'situacao', 'ativadoEm', 'revogadoEm', 'codigo', 'credencial', 'tipo', 'ativa', 'id'];
    for (const corpo of corpos) for (const campo of proibidos) assert.equal(Object.hasOwn(corpo, campo), false, campo);
  });
});

describe('contrato com o backend', () => {
  test('recurso, ações e rotas conferem com as do servidor', () => {
    assert.equal(T.ACAO.REVOGAR, constante('routes/token-dispositivo.routes.js', 'ACAO_REVOGAR_DISPOSITIVO'));
    assert.equal(T.ACAO.GERAR_ATIVACAO, constante('routes/token-ativacao.routes.js', 'ACAO_GERAR_ATIVACAO'));
    assert.equal(T.ACAO.REDES, constante('routes/token-central.routes.js', 'ACAO_REDES'));
    assert.equal(T.ACAO.PREVIA, constante('routes/token-central.routes.js', 'ACAO_PREVIA'));
    assert.equal(constante('routes/token-central.routes.js', 'RECURSO'), 'atendimentoToken');
    for (const rota of ['token-central.routes.js', 'token-dispositivo.routes.js']) assert.match(fonteDoBackend(`routes/${rota}`), /'\/atendimento-token/);
  });

  test('situação geral e estados do catálogo: as mesmas chaves do servidor', () => {
    const central = fonteDoBackend('services/token-central.service.js');
    const doBackend = [...central.matchAll(/return '([A-Z_]+)';/g)].map((m) => m[1]).filter((v) => v.startsWith('SEM_') || v.startsWith('COM_'));
    assert.deepEqual([...new Set(doBackend)].sort(), Object.keys(T.SITUACOES_GERAIS).sort());
    const estados = /const ESTADOS = Object\.freeze\(\{([^}]+)\}\)/.exec(fonteDoBackend('services/token-catalogo.service.js'))[1];
    assert.deepEqual([...estados.matchAll(/(\w+): '/g)].map((m) => m[1]).sort(), Object.keys(T.ESTADOS_CATALOGO).sort());
  });

  test('limites do formulário iguais aos do schema (nome, local, outros e descrição da rede)', () => {
    const corpo = (campo, n) => dispositivoSchemas.criar.body.safeParse({ nome: 'A', [campo]: 'x'.repeat(n) }).success;
    for (const [campo, max] of [['unidade', 100], ['setor', 100], ['localInstalacao', 150], ['fabricante', 100], ['modelo', 100], ['numeroSerie', 100]]) {
      assert.equal(T.formulario.LIMITES[campo], max, campo);
      assert.equal(corpo(campo, max), true, `${campo} no limite`);
      assert.equal(corpo(campo, max + 1), false, `${campo} acima do limite`);
      assert.deepEqual(T.formulario.validar({ nome: 'A', [campo]: 'x'.repeat(max) }), {});
      assert.deepEqual(Object.keys(T.formulario.validar({ nome: 'A', [campo]: 'x'.repeat(max + 1) })), [campo]);
    }
    assert.equal(T.formulario.LIMITES.nome, 100);
    assert.equal(T.rede.LIMITE_DESCRICAO, centralSchemas.DESCRICAO_MAXIMA);
  });

  test('o endereço IP: o que a tela aceita é o que o servidor aceita (nenhuma recusa indevida, nenhuma aceitação indevida)', () => {
    const amostras = [
      '192.168.0.1', '10.0.0.1', '255.255.255.255', '1.1.1.1', '127.0.0.1', '::1', 'fe80::1', '2001:db8::1', '2001:0db8:0000:0000:0000:0000:0000:0001',
      '::ffff:192.168.0.1', '1::', '2001:DB8::A', '1:2:3:4:5:6:7:8', '1:2:3:4:5:6:1.2.3.4',
      '', ' ', '0.0.0.0', '::', '10.0.0.0/24', '10.0.0.1/32', '10.0.0.1-10.0.0.5', '10.0.0.*', '256.1.1.1', '1.2.3', '1.2.3.4.5', 'abc', '1.2.3.4 x',
      'fe80::1%eth0', '1::2::3', '12345::1', 'g::1', '10.0.0.1,10.0.0.2', '2001:db8::/32', ':::1', '1:2:3:4:5:6:7:8:9', '1:2:3:4:5:6:7',
    ];
    for (const s of amostras) {
      const servidor = centralSchemas.cadastrarRede.body.safeParse({ rede: s }).success;
      const tela = T.rede.validarEndereco(s) === '';
      assert.equal(tela, servidor, `"${s}": tela=${tela} servidor=${servidor}`);
    }
  });
});

describe('formulário do dispositivo', () => {
  test('nome obrigatório; opcionais em branco são aceitos; texto aparado e sem controle', () => {
    assert.deepEqual(Object.keys(T.formulario.validar({})), ['nome']);
    assert.deepEqual(Object.keys(T.formulario.validar({ nome: '   ' })), ['nome']);
    assert.deepEqual(T.formulario.validar({ nome: '  Tablet  ', unidade: '   ' }), {});
    assert.deepEqual(Object.keys(T.formulario.validar({ nome: 'A\u0007B' })), ['nome']);
    assert.deepEqual(Object.keys(T.formulario.validar({ nome: 'A', setor: 'x\ny' })), ['setor']);
    assert.equal(T.formulario.validar({ nome: 'x'.repeat(101) }).nome, T.POR_CODIGO.NOME_INVALIDO);
    assert.deepEqual(T.formulario.validar({ nome: '😀'.repeat(100) }), {}, 'o limite é em pontos de código, como o do banco');
  });

  test('cadastro envia só o nome e os opcionais preenchidos (aparados)', () => {
    assert.deepEqual(T.formulario.corpoCriacao({ nome: '  Tablet 1 ', unidade: '', setor: ' Expedição ', numeroSerie: 'SN1' }), { nome: 'Tablet 1', setor: 'Expedição', numeroSerie: 'SN1' });
  });

  test('edição envia só o que mudou; opcional esvaziado vai como null; nada mudou = corpo vazio', () => {
    const original = { nome: 'A', unidade: 'U', setor: null, localInstalacao: 'L', fabricante: null, modelo: null, numeroSerie: 'N' };
    assert.deepEqual(T.formulario.corpoEdicao(original, { nome: 'A', unidade: 'U', setor: '', localInstalacao: 'L', fabricante: '', modelo: '', numeroSerie: 'N' }), {});
    assert.deepEqual(T.formulario.corpoEdicao(original, { nome: 'B', unidade: '', setor: 'S', localInstalacao: 'L', fabricante: '', modelo: '', numeroSerie: 'N' }), { nome: 'B', unidade: null, setor: 'S' });
  });
});

describe('redes: validação local e decisão da última rede', () => {
  test('descrição opcional até 150 pontos, sem controle', () => {
    assert.equal(T.rede.validarDescricao(''), '');
    assert.equal(T.rede.validarDescricao('x'.repeat(150)), '');
    assert.equal(T.rede.validarDescricao('x'.repeat(151)), T.POR_CODIGO.DESCRICAO_INVALIDA);
    assert.equal(T.rede.validarDescricao('a\u0000b'), T.POR_CODIGO.DESCRICAO_INVALIDA);
    assert.deepEqual(T.rede.corpo({ rede: ' 10.0.0.1 ', descricao: '  ' }), { rede: '10.0.0.1' });
    assert.deepEqual(T.rede.corpo({ rede: '10.0.0.1', descricao: ' Matriz ' }), { rede: '10.0.0.1', descricao: 'Matriz' });
  });

  test('"única ativa" só quando a lista é conhecida por completo e há exatamente uma ativa', () => {
    const r = (id, ativa) => ({ id, ativa });
    assert.equal(T.rede.ehUnicaAtiva([r(1, true), r(2, false)], 1, false), true);
    assert.equal(T.rede.ehUnicaAtiva([r(1, true), r(2, true)], 1, false), false);
    assert.equal(T.rede.ehUnicaAtiva([r(1, false)], 1, false), false);
    assert.equal(T.rede.ehUnicaAtiva([r(1, true), r(2, false)], 2, false), false);
    assert.equal(T.rede.ehUnicaAtiva([r(1, true)], 1, true), false, 'lista incompleta não afirma "única"');
    assert.equal(T.rede.ehUnicaAtiva(null, 1, false), false);
  });
});

describe('modelos: só o formato exato do servidor', () => {
  const geral = (extra) => ({ status: 'ok', visaoGeral: { dispositivos: { cadastrados: 3, ativos: 1, pendentes: 1, revogados: 1 }, ativacoesPendentes: 1, situacaoGeral: 'COM_DISPOSITIVO_ATIVO', ...extra } });

  test('visão geral: números inteiros não negativos e situação conhecida; qualquer desvio é recusado (nunca zero)', () => {
    assert.deepEqual(T.modelo.visaoGeral(geral()).dispositivos, { cadastrados: 3, ativos: 1, pendentes: 1, revogados: 1 });
    for (const ruim of [
      geral({ situacaoGeral: 'OUTRA' }), geral({ ativacoesPendentes: -1 }), geral({ ativacoesPendentes: '1' }),
      geral({ dispositivos: { cadastrados: 3, ativos: 1, pendentes: 1 } }), geral({ dispositivos: null }),
      { status: 'ok' }, null, undefined, 'x', { visaoGeral: [] },
    ]) assert.equal(T.modelo.visaoGeral(ruim), null);
  });

  test('ativação: os cinco estados; outro valor é recusado; nenhum campo de segredo é copiado', () => {
    for (const estado of T.ESTADOS_ATIVACAO) assert.equal(T.modelo.ativacao({ ativacao: { estado, geradaEm: null, expiraEm: null, usadaEm: null, canceladaEm: null } }).estado, estado);
    assert.equal(T.modelo.ativacao({ ativacao: { estado: 'ATIVA' } }), null);
    assert.equal(T.modelo.ativacao({}), null);
    const copiado = T.modelo.ativacao({ ativacao: { estado: 'PENDENTE', geradaEm: 'a', expiraEm: 'b', usadaEm: null, canceladaEm: null, codigo: 'SEGREDO', codigoHash: 'h' } });
    assert.deepEqual(Object.keys(copiado).sort(), ['canceladaEm', 'estado', 'expiraEm', 'geradaEm', 'usadaEm']);
  });

  test('dispositivo e rede: tipos conferidos', () => {
    const d = { id: 1, nome: 'T', situacao: 'ATIVO', unidade: null, ativadoEm: '2026-10-12T10:00:00.000Z' };
    assert.equal(T.modelo.dispositivo(d).situacao, 'ATIVO');
    for (const ruim of [null, {}, { ...d, id: 0 }, { ...d, nome: 5 }, { ...d, situacao: 'DESCONHECIDA' }]) assert.equal(T.modelo.dispositivo(ruim), null);
    assert.equal(T.modelo.rede({ id: 2, endereco: '10.0.0.1', ativa: true, descricao: null, criadaEm: null, desativadaEm: null }).ativa, true);
    for (const ruim of [null, { id: 2, endereco: '10.0.0.1' }, { id: 2, endereco: 3, ativa: true }]) assert.equal(T.modelo.rede(ruim), null);
  });

  test('funcionário da busca da prévia: nome, matrícula, cargo, setor e GHE; sem CPF; cargo ausente vira null (S4)', () => {
    const f = { id: 31, nome: 'Ana', matricula: 'M31', funcao: 'Operador', setor: 'Produção', cpfMascarado: '***.***.***-12', situacao: 'ATIVO', grupoHomogeneo: { id: 2, descricao: 'GHE Produção' } };
    assert.deepEqual(T.modelo.funcionario(f), { id: 31, nome: 'Ana', matricula: 'M31', funcao: 'Operador', setor: 'Produção', ghe: 'GHE Produção', situacao: 'ATIVO' });
    assert.equal(T.modelo.funcionario({ ...f, funcao: undefined }).funcao, null);
    assert.equal(T.modelo.funcionario({ ...f, funcao: null }).funcao, null);
    assert.equal(Object.hasOwn(T.modelo.funcionario(f), 'cpfMascarado'), false);
    assert.equal(T.modelo.funcionario({ ...f, id: 0 }), null);
  });

  test('prévia: o catálogo do tablet (estado conhecido, total inteiro, materiais com id e nome)', () => {
    const catalogo = { estado: 'OK', total: 1, materiais: [{ id: 5, nome: 'Luva', unidade: 'par', categoria: 'EPI', tipo: { id: 1, nome: 'Luva' }, exigeTamanho: true, tamanhos: ['P', 'M'], imagem: { disponivel: false } }] };
    const p = T.modelo.previa({ status: 'ok', previa: { catalogo } });
    assert.deepEqual(p.materiais[0], { id: 5, nome: 'Luva', unidade: 'par', categoria: 'EPI', tipo: 'Luva', exigeTamanho: true, tamanhos: ['P', 'M'] });
    for (const ruim of [{ previa: { catalogo: { ...catalogo, estado: 'X' } } }, { previa: { catalogo: { ...catalogo, total: -1 } } }, { previa: { catalogo: { ...catalogo, materiais: [{ id: 1 }] } } }, { previa: {} }, {}]) assert.equal(T.modelo.previa(ruim), null);
  });

  test('a geração da ativação exige código e prazo e limita o prazo a 10 minutos a partir de agora', () => {
    const agora = Date.UTC(2026, 9, 12, 12, 0, 0);
    const longe = new Date(agora + 60 * 60 * 1000).toISOString();
    const perto = new Date(agora + 5 * 60 * 1000).toISOString();
    assert.equal(T.ativacao.daGeracao({ ativacao: { dispositivoId: 3, codigo: 'ABC', expiraEm: longe } }, agora).fimMs, agora + 10 * 60 * 1000);
    assert.equal(T.ativacao.daGeracao({ ativacao: { dispositivoId: 3, codigo: 'ABC', expiraEm: perto } }, agora).fimMs, agora + 5 * 60 * 1000);
    for (const ruim of [{}, { ativacao: { dispositivoId: 3, codigo: '', expiraEm: perto } }, { ativacao: { dispositivoId: 3, codigo: 'A', expiraEm: 'xx' } }, { ativacao: { codigo: 'A', expiraEm: perto } }]) assert.equal(T.ativacao.daGeracao(ruim, agora), null);
    assert.equal(T.ativacao.restanteMs(agora + 1000, agora + 5000), 0, 'nunca negativo');
  });
});

describe('mensagens: sempre os textos daqui, nunca o do servidor', () => {
  test('por status e por código', () => {
    const r = (status, codigo, mensagem = 'TEXTO DO SERVIDOR') => ({ ok: false, status, codigo, mensagem });
    assert.match(T.mensagens.deErro(r(0, 'FALHA_DE_REDE')), /Verifique sua conexão/);
    assert.match(T.mensagens.deErro(r(401)), /sessão expirou/);
    assert.match(T.mensagens.deErro(r(500)), /Tente novamente/);
    assert.equal(T.mensagens.deErro(r(409, 'DISPOSITIVO_REVOGADO')), T.POR_CODIGO.DISPOSITIVO_REVOGADO);
    assert.equal(T.mensagens.deErro(r(403, 'QUALQUER')), T.POR_CODIGO.PERMISSAO_NEGADA);
    assert.equal(T.mensagens.deErro({ ok: true }), '');
    for (const status of [0, 400, 401, 403, 404, 409, 429, 500]) assert.equal(T.mensagens.deErro(r(status, 'DESCONHECIDO')).includes('TEXTO DO SERVIDOR'), false, String(status));
    assert.equal(T.mensagens.exigeNovoLogin(r(401)), true);
    assert.equal(T.mensagens.exigeNovoLogin(r(403)), false);
  });

  test('erros de campo: 400 pelo caminho body.<campo> e 409 de unicidade pelo código; campos fora da lista são ignorados', () => {
    const permitidos = T.formulario.CAMPOS;
    const r400 = { ok: false, status: 400, detalhes: [
      { campo: 'body.nome', codigo: 'NOME_INVALIDO', mensagem: 'MSG DO SERVIDOR' },
      { campo: 'body.setor', codigo: 'CODIGO_NOVO', mensagem: 'x' },
      { campo: 'body.outro', codigo: 'NOME_INVALIDO' },
      { campo: 'params.id', codigo: 'NOME_INVALIDO' },
    ] };
    assert.deepEqual(T.mensagens.deCampos(r400, permitidos), [{ campo: 'nome', mensagem: T.POR_CODIGO.NOME_INVALIDO }, { campo: 'setor', mensagem: T.POR_CODIGO.VALIDACAO }]);
    assert.deepEqual(T.mensagens.deCampos({ ok: false, status: 409, codigo: 'DISPOSITIVO_NOME_EM_USO' }, permitidos), [{ campo: 'nome', mensagem: T.POR_CODIGO.DISPOSITIVO_NOME_EM_USO }]);
    assert.deepEqual(T.mensagens.deCampos({ ok: false, status: 409, codigo: 'REDE_JA_AUTORIZADA' }, ['rede', 'descricao']), [{ campo: 'rede', mensagem: T.POR_CODIGO.REDE_JA_AUTORIZADA }]);
    assert.deepEqual(T.mensagens.deCampos({ ok: false, status: 409, codigo: 'DISPOSITIVO_REVOGADO' }, permitidos), []);
    assert.deepEqual(T.mensagens.deCampos({ ok: true }, permitidos), []);
  });
});

describe('capacidades: só as permissões reais, nunca o nome do perfil', () => {
  const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
  const area = (v) => ({ consultar: v, alterar: v });
  const permissoes = ({ recurso = {}, acoes = {}, perfil = 'ADMINISTRADOR', funcionarios = false } = {}) => ({
    empresaId: 3, usuarioId: 7, perfil,
    recursos: { atendimentoToken: { ...NENHUMA, ...recurso }, employeeHistory: { ...NENHUMA, visualizar: funcionarios } },
    acoes,
    administracao: { gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), vinculosSst: area(false), autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false } },
  });

  test('sem nenhuma permissão: nada é oferecido e a página não abre', () => {
    const c = T.capacidades(permissoes());
    assert.deepEqual([c.visualizar, c.criar, c.editar, c.revogar, c.gerarAtivacao, c.redes, c.previa], [false, false, false, false, false, false, false]);
    assert.deepEqual(Object.keys(c.abas).filter((a) => c.abas[a]), ['monitoramento', 'historico']);
    assert.equal(P.podeAbrir(permissoes(), 'atendimentoToken'), false);
  });

  test('o MASTER não é presumido: perfil MASTER sem as linhas de permissão não ganha nada', () => {
    const c = T.capacidades(permissoes({ perfil: 'MASTER' }));
    assert.deepEqual([c.visualizar, c.criar, c.editar, c.revogar, c.gerarAtivacao, c.redes, c.previa], [false, false, false, false, false, false, false]);
    assert.equal(P.podeAbrir(permissoes({ perfil: 'MASTER' }), 'atendimentoToken'), false);
  });

  test('visualizar abre a lista; criar, editar e revogar dependem de visualizar e de cada permissão', () => {
    const so = T.capacidades(permissoes({ recurso: { visualizar: true } }));
    assert.deepEqual([so.visualizar, so.criar, so.editar, so.revogar], [true, false, false, false]);
    const tudo = T.capacidades(permissoes({ recurso: { visualizar: true, criar: true, editar: true }, acoes: { TOKEN_REVOGAR_DISPOSITIVO: true } }));
    assert.deepEqual([tudo.criar, tudo.editar, tudo.revogar], [true, true, true]);
    const semLista = T.capacidades(permissoes({ recurso: { criar: true, editar: true }, acoes: { TOKEN_REVOGAR_DISPOSITIVO: true } }));
    assert.deepEqual([semLista.visualizar, semLista.criar, semLista.editar, semLista.revogar], [false, false, false, false], 'sem a lista não há como agir sobre um dispositivo');
  });

  test('ativação, redes e prévia são ações independentes; cada uma abre a página sozinha', () => {
    for (const [acao, aba, campo] of [['TOKEN_GERAR_ATIVACAO', 'ativacao', 'gerarAtivacao'], ['TOKEN_GERENCIAR_REDES', 'ativacao', 'redes'], ['TOKEN_PREVIA_CATALOGO_REAL', 'previa', 'previa']]) {
      const p = permissoes({ acoes: { [acao]: true } });
      const c = T.capacidades(p);
      assert.equal(c[campo], true, campo);
      assert.equal(c.abas[aba], true, aba);
      assert.equal(c.visualizar, false);
      assert.equal(P.podeAbrir(p, 'atendimentoToken'), true, acao);
    }
    assert.equal(P.podeAbrir(permissoes({ acoes: { TOKEN_REVOGAR_DISPOSITIVO: true } }), 'atendimentoToken'), false, 'revogar sozinha não tem o que mostrar');
  });

  test('a busca de funcionário depende do cadastro de funcionários; monitoramento e histórico só são lidos como reservados', () => {
    assert.equal(T.capacidades(permissoes({ funcionarios: true })).buscarFuncionario, true);
    assert.equal(T.capacidades(permissoes()).buscarFuncionario, false);
    const c = T.capacidades(permissoes({ acoes: { TOKEN_VISUALIZAR_MONITORAMENTO: true, TOKEN_VISUALIZAR_HISTORICO: true } }));
    assert.deepEqual([c.monitoramento, c.historico], [true, true]);
  });
});

describe('ordem das abas e rótulos', () => {
  test('as sete abas, nesta ordem (K7: Visualizar Totem depois de Histórico)', () => {
    assert.deepEqual(T.ABAS, ['visaoGeral', 'dispositivos', 'ativacao', 'monitoramento', 'previa', 'historico', 'visualizarTotem']);
    assert.deepEqual(T.ABAS.map((a) => T.ROTULOS_ABA[a]), ['Visão Geral', 'Dispositivos', 'Ativação', 'Monitoramento', 'Prévia e Testes', 'Histórico', 'Visualizar Totem']);
  });
});
