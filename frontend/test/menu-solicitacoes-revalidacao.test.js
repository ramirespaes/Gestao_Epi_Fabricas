'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * 12G-1 (correção do menu) — os três itens de "Solicitações" (Pedido de EPI,
 * Aprovação da Segurança do Trabalho e Entregas por solicitação) seguem SÓ as
 * permissões efetivas do servidor, em todas as páginas integradas, e o menu
 * acompanha as permissões quando a página volta pelo histórico (BFCache) com a
 * mesma sessão: as permissões são consultadas de novo, como o Início do Portal
 * já fazia. Nada é inferido pelo perfil.
 */

// A Ficha de EPI fica fora só da abertura por DOM: o harness não tem canvas (assinatura). O menu
// dela é conferido estaticamente em solicitacoes-12g1-paginas.test.js e a página em epi-ficha.test.js.
const INTEGRADAS = ['available-items.html', 'dashboard.html', 'employee-groups.html', 'employee-history.html', 'gestao-usuarios.html', 'import-employees.html', 'materials.html', 'operations.html',
  'request.html', 'stock-requests.html', 'stock-validity.html', 'supervisor-approval.html'];
const ITENS = { request: 'Pedido de EPI', supervisorApproval: 'Aprovação da Segurança do Trabalho', stockRequests: 'Entregas por solicitação' };

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
function permissoes({ perfil = 'ADMINISTRADOR', recursos = {}, acoes = {} } = {}) {
  return {
    status: 'ok', empresaId: 3, usuarioId: 7, perfil, recursos: { dashboard: { ...NENHUMA, visualizar: true }, ...recursos }, acoes,
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: true, concederDireta: false, delegar: false }, vinculosSst: area(false),
    },
  };
}
const contexto = (perfil) => ({ status: 'ok', usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@example.invalid', perfil }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' } });

/** Abre a página com permissões que o teste pode trocar depois (o "servidor" muda entre a carga e a volta pelo histórico). */
function abrir(arquivo, inicial) {
  // `segurar.me` / `segurar.permissoes`: uma promessa que mantém a resposta pendente até o teste soltar.
  const servidor = { permissoes: inicial, status: 200, segurar: {} };
  const depois = (nome, resposta) => (servidor.segurar[nome] ? servidor.segurar[nome].then(resposta) : resposta());
  const pg = abrirPagina(`pages/${arquivo}`, {
    rotas: {
      'GET /auth/me': () => depois('me', () => ({ status: 200, corpo: contexto(servidor.permissoes.perfil) })),
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': () => depois('permissoes', () => (servidor.status === 200 ? { status: 200, corpo: servidor.permissoes } : { status: servidor.status, corpo: { status: 'error', codigo: 'X', message: 'x' } })),
    },
  });
  return { pg, servidor };
}
function pendente() {
  let soltar;
  const promessa = new Promise((r) => { soltar = r; });
  return { promessa, soltar };
}
const visiveis = (pg) => Object.keys(ITENS).filter((p) => pg.visivelNo(pg.consulta(`.nav a[data-pagina="${p}"]`)[0]));
const consultasDePermissao = (pg) => pg.chamadas.filter((c) => c.chave === 'GET /auth/permissoes').length;
const voltarPeloHistorico = (pg) => pg.eventoDaJanela('pageshow', { persisted: true });

// ─────────────────────────────────────────────────────────────────────
describe('markup atual: nenhum arquivo do frontend traz o menu de Solicitações anterior à 12G-1', () => {
  const RAIZ = path.join(__dirname, '..');
  const FORA = new Set(['test', 'node_modules', 'vendor']);
  const arquivos = (dir) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) return FORA.has(e.name) ? [] : arquivos(p);
    return /\.(html|js)$/.test(e.name) ? [p] : [];
  });

  test('nenhum HTML ou JS (páginas, Portal, Painel Privado, institucional) tem "Aprovação do Supervisor" ou "Sem Estoque", nem os três itens como "Em integração"', () => {
    const lidos = arquivos(RAIZ);
    assert.ok(lidos.length > 40, 'a varredura alcança o frontend inteiro');
    const ITEM = /<a\b[^>]*>(?:(?!<\/a>)[\s\S])*?(?:Pedido de EPI|Aprovação da Segurança do Trabalho|Entregas por solicitação)(?:(?!<\/a>)[\s\S])*?<\/a>/g;
    for (const arquivo of lidos) {
      const codigo = fs.readFileSync(arquivo, 'utf8');
      const nome = path.relative(RAIZ, arquivo);
      assert.equal(/Aprovação do Supervisor|Sem Estoque/.test(codigo), false, nome);
      for (const [item] of codigo.matchAll(ITEM)) assert.equal(/nav-pendente|Em integração/.test(item), false, `${nome}: ${item}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('caracterização: com a permissão efetiva do servidor, cada item aparece nas páginas integradas', () => {
  const CASOS = [
    ['request.visualizar', permissoes({ recursos: { request: { ...NENHUMA, visualizar: true } } }), ['request']],
    ['request.criar', permissoes({ recursos: { request: { ...NENHUMA, criar: true } } }), ['request']],
    ['request.editar sozinho', permissoes({ recursos: { request: { ...NENHUMA, editar: true } } }), []],
    ['APROVAR_SOLICITACAO', permissoes({ acoes: { APROVAR_SOLICITACAO: true } }), ['supervisorApproval']],
    ['REPROVAR_SOLICITACAO sozinha', permissoes({ acoes: { REPROVAR_SOLICITACAO: true } }), []],
    ['REALIZAR_ENTREGA', permissoes({ acoes: { REALIZAR_ENTREGA: true } }), ['stockRequests']],
    ['ENCERRAR_SOLICITACAO', permissoes({ acoes: { ENCERRAR_SOLICITACAO: true } }), ['stockRequests']],
    ['tudo (o cenário da revisão)', permissoes({ recursos: { request: { visualizar: true, criar: true, editar: true, excluir: false } }, acoes: { APROVAR_SOLICITACAO: true, REPROVAR_SOLICITACAO: true, ENCERRAR_SOLICITACAO: true, REALIZAR_ENTREGA: true } }), ['request', 'supervisorApproval', 'stockRequests']],
    ['nada', permissoes(), []],
    ['MASTER sem concessão efetiva (o perfil não decide)', permissoes({ perfil: 'MASTER' }), []],
  ];

  for (const arquivo of INTEGRADAS) {
    test(`${arquivo}: os três itens seguem só as permissões; o Dashboard continua pela sua`, async () => {
      for (const [nome, p, esperado] of CASOS) {
        const { pg } = abrir(arquivo, p);
        await pg.esperar();
        assert.deepEqual(visiveis(pg), esperado, `${arquivo} — ${nome}`);
        assert.equal(pg.visivelNo(pg.consulta('.nav a[data-pagina="dashboard"]')[0]), true, `${arquivo} — ${nome}: o resto do menu não regride`);
        for (const [pagina, rotulo] of Object.entries(ITENS)) assert.ok(pg.consulta(`.nav a[data-pagina="${pagina}"]`)[0].textContent.includes(rotulo), rotulo);
      }
    });
  }
});

// ─────────────────────────────────────────────────────────────────────
describe('volta pelo histórico com a mesma sessão: o menu acompanha as permissões do servidor', () => {
  const SEM_SOLICITACAO = permissoes();
  const COM_TUDO = permissoes({ recursos: { request: { visualizar: true, criar: true, editar: true, excluir: false } }, acoes: { APROVAR_SOLICITACAO: true, REPROVAR_SOLICITACAO: true, ENCERRAR_SOLICITACAO: true, REALIZAR_ENTREGA: true } });

  test('Dashboard: concedidas as permissões depois da carga, a volta consulta de novo, mostra os três itens e recarrega a página (nada fica oculto para sempre)', async () => {
    const { pg, servidor } = abrir('dashboard.html', SEM_SOLICITACAO);
    await pg.esperar();
    assert.deepEqual(visiveis(pg), []);
    servidor.permissoes = COM_TUDO;
    await voltarPeloHistorico(pg);
    assert.equal(consultasDePermissao(pg), 2, 'as permissões são consultadas de novo');
    assert.deepEqual(visiveis(pg), ['request', 'supervisorApproval', 'stockRequests']);
    assert.deepEqual(pg.navegacoes, ['/pages/dashboard.html'], 'permissões mudaram: a página refaz o fluxo dela do zero');
    assert.equal(pg.visivel('telaSessao'), true, 'a tela de verificação cobre a página até recarregar');
  });

  test('permissões iguais: consulta de novo, não recarrega e libera a página como estava', async () => {
    const { pg } = abrir('dashboard.html', COM_TUDO);
    await pg.esperar();
    await voltarPeloHistorico(pg);
    assert.equal(consultasDePermissao(pg), 2);
    assert.deepEqual(pg.navegacoes, []);
    assert.equal(pg.visivel('telaSessao'), false);
    assert.deepEqual(visiveis(pg), ['request', 'supervisorApproval', 'stockRequests']);
  });

  test('página da 12G-1 que perdeu o acesso: o item some, a página recarrega e o conteúdo protegido não fica à mostra', async () => {
    const { pg, servidor } = abrir('request.html', COM_TUDO);
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), true);
    servidor.permissoes = SEM_SOLICITACAO;
    await voltarPeloHistorico(pg);
    assert.deepEqual(visiveis(pg), []);
    assert.deepEqual(pg.navegacoes, ['/pages/request.html']);
    assert.equal(pg.visivel('telaSessao'), true);
  });

  test('sessão encerrada no servidor (401 nas permissões): Portal, sem liberar a página', async () => {
    const { pg, servidor } = abrir('stock-requests.html', COM_TUDO);
    await pg.esperar();
    servidor.status = 401;
    await voltarPeloHistorico(pg);
    assert.deepEqual(pg.navegacoes, ['../portal/index.html']);
    assert.deepEqual(visiveis(pg), []);
    assert.equal(pg.visivel('telaSessao'), true);
  });

  test('falha ao consultar as permissões: menu fechado e a tela de verificação avisa (falha fechada, sem revelar a página antiga)', async () => {
    const { pg, servidor } = abrir('supervisor-approval.html', COM_TUDO);
    await pg.esperar();
    servidor.status = 500;
    await voltarPeloHistorico(pg);
    assert.deepEqual(visiveis(pg), []);
    assert.equal(pg.visivel('telaSessao'), true);
    assert.ok(pg.el('telaSessaoMensagem').textContent.includes(pg.janela.EpiPermissoes.MENSAGENS.FALHA));
    assert.equal(pg.visivel('telaSessaoPortal'), true);
    assert.deepEqual(pg.navegacoes, []);
  });

  for (const [arquivo, permissoesDaPagina] of [['request.html', COM_TUDO], ['supervisor-approval.html', COM_TUDO], ['stock-requests.html', COM_TUDO]]) {
    for (const etapa of ['me', 'permissoes']) {
      test(`${arquivo}: durante a revalidação (${etapa === 'me' ? 'sessão' : 'permissões'} ainda pendente), o conteúdo protegido fica fechado, não só coberto; liberada, a página volta como estava`, async () => {
        const { pg, servidor } = abrir(arquivo, permissoesDaPagina);
        await pg.esperar();
        assert.equal(pg.visivel('conteudoProtegido'), true);
        const espera = pendente();
        servidor.segurar[etapa] = espera.promessa;
        const volta = voltarPeloHistorico(pg);
        await pg.esperar();
        assert.equal(pg.visivel('telaSessao'), true, 'a tela de verificação aparece na hora');
        assert.equal(pg.visivel('conteudoProtegido'), false, 'o conteúdo antigo não fica alcançável (leitor de tela, Tab) enquanto o servidor não responde');
        servidor.segurar[etapa] = null;
        espera.soltar();
        await volta;
        await pg.esperar();
        assert.equal(pg.visivel('telaSessao'), false);
        assert.equal(pg.visivel('conteudoProtegido'), true, 'mesma sessão e mesmas permissões: reaparece');
        assert.deepEqual(pg.navegacoes, []);
      });
    }
  }

  test('falha na revalidação com a resposta atrasada: o conteúdo continua fechado (falha fechada)', async () => {
    const { pg, servidor } = abrir('request.html', COM_TUDO);
    await pg.esperar();
    const espera = pendente();
    servidor.segurar.permissoes = espera.promessa;
    servidor.status = 500;
    const volta = voltarPeloHistorico(pg);
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), false);
    servidor.segurar.permissoes = null;
    espera.soltar();
    await volta;
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.equal(pg.visivel('telaSessao'), true);
    assert.ok(pg.el('telaSessaoMensagem').textContent.includes(pg.janela.EpiPermissoes.MENSAGENS.FALHA));
  });

  test('página que abriu sem acesso (conteúdo nunca exibido): a volta liberada não revela o conteúdo', async () => {
    const { pg } = abrir('supervisor-approval.html', SEM_SOLICITACAO);
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), false);
    await voltarPeloHistorico(pg);
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.deepEqual(pg.navegacoes, []);
  });

  test('MASTER sem concessão efetiva continua sem os itens depois da volta (o perfil não decide)', async () => {
    const { pg } = abrir('dashboard.html', permissoes({ perfil: 'MASTER' }));
    await pg.esperar();
    await voltarPeloHistorico(pg);
    assert.deepEqual(visiveis(pg), []);
    assert.equal(consultasDePermissao(pg), 2);
  });
});
