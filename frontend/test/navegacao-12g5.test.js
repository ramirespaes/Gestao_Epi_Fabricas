'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * 12G-5 — links e navegação SST. Sem tela nova e sem mudar os fluxos da 12G-2 a
 * 12G-4: o Portal não descreve como "em integração" o que já está integrado, o
 * acesso é atribuído às permissões efetivas (nunca só ao perfil), Permissões do
 * Grupo explica que só "Aprovar solicitação" abre a Aprovação, e as três telas da
 * solicitação acompanham a sessão na volta pelo histórico (troca de empresa ou de
 * pessoa, perda de sessão e perda de permissão).
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const semComentarios = (s) => s.replace(/<!--[\s\S]*?-->/g, '');
const textoDe = (html) => html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();

// ─────────────────────────────────────────────────────────────────────
describe('Início do Portal', () => {
  const html = semComentarios(ler('portal/inicio.html'));
  const secao = (titulo) => {
    const m = html.match(new RegExp(`<section class="bloco">\\s*<h2>${titulo}</h2>([\\s\\S]*?)</section>`));
    assert.ok(m, `seção "${titulo}"`);
    return m[1];
  };

  test('"Em integração" não lista como pendente o que já está integrado (Estoque e GHE) nem promete etapa já entregue', () => {
    const pendentes = textoDe(secao('Em integração'));
    assert.equal(/\bEstoque\b|\bGHE\b|Etapa C|Bloco 9/.test(pendentes), false, pendentes);
    const integrados = textoDe(secao('Módulos já integrados ao servidor'));
    assert.match(integrados, /Gestão de estoque/);
    assert.match(integrados, /Gestão de GHE/);
  });

  test('os módulos integrados seguem as permissões efetivas: o texto não atribui o acesso só ao perfil', () => {
    const integrados = textoDe(secao('Módulos já integrados ao servidor'));
    assert.equal(/seu perfil|do perfil/i.test(integrados), false, integrados);
    assert.match(integrados, /permiss/i);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('mensagem global de acesso negado', () => {
  require('../js/permissoes-efetivas'); // eslint-disable-line global-require
  const P = globalThis.EpiPermissoes;
  const E = require('../js/estado-pagina'); // eslint-disable-line global-require

  test('não atribui o acesso só ao perfil; fala de permissão; o estado padrão e o aviso das páginas dizem o mesmo', () => {
    for (const [onde, texto] of [['EpiPermissoes.MENSAGENS.SEM_ACESSO', P.MENSAGENS.SEM_ACESSO], ['EpiEstadoPagina acesso-negado', E.MENSAGENS['acesso-negado']]]) {
      assert.equal(/perfil/i.test(texto), false, `${onde}: ${texto}`);
      assert.match(texto, /permiss/i, onde);
    }
    assert.equal(E.MENSAGENS['acesso-negado'], P.MENSAGENS.SEM_ACESSO);
  });

  test('na tela: quem abre uma página sem a permissão (inclusive o MASTER sem concessão) vê o acesso negado sem menção a perfil', async () => {
    const pg = abrirPagina('pages/request.html', { rotas: rotasDeSessao({ empresa: 3, usuario: 7, perfil: 'MASTER', permissoes: permissoes({ perfil: 'MASTER' }) }) });
    await pg.esperar();
    assert.equal(pg.consulta('#estadoPagina [data-estado="acesso-negado"]').length, 1);
    assert.equal(/perfil/i.test(pg.el('estadoPagina').textContent), false, pg.el('estadoPagina').textContent);
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('Permissões do Grupo: a Aprovação da Segurança do Trabalho', () => {
  test('a nota diz que "Aprovar solicitação" dá o acesso à página e que "Reprovar solicitação" sozinha não abre (reprova dentro dela)', () => {
    const { nota } = require('../js/grupo-permissoes').RECURSOS.find((r) => r.id === 'supervisorApproval'); // eslint-disable-line global-require
    assert.match(nota, /Aprovar solicitação[^.]*(abre|acesso)/, nota);
    assert.match(nota, /Reprovar solicitação[^.]*(sozinha não|não abre)/, nota);
    assert.match(nota, /vínculo SST/, 'continua avisando que as duas ações exigem o vínculo SST');
  });
});

// ─────────────────────────────────────────────────────────────────────
// Volta pelo histórico (BFCache) nas três telas da solicitação. O conteúdo fechado durante a revalidação
// pendente já é conferido em menu-solicitacoes-revalidacao.test.js para as três; aqui, o que mudou na sessão.
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
function permissoes({ empresa = 3, usuario = 7, perfil = 'ADMINISTRADOR', recursos = {}, acoes = {} } = {}) {
  return {
    status: 'ok', empresaId: empresa, usuarioId: usuario, perfil, recursos: { request: NENHUMA, ...recursos }, acoes,
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: true, concederDireta: false, delegar: false }, vinculosSst: area(false),
    },
  };
}
const linha = (status) => ({
  id: 301, numero: 41, status, situacaoOperacional: null, solicitanteUsuarioId: 9,
  funcionario: { id: 11, nome: 'Ana Sintética', matricula: 'M-011', ativo: true }, quantidadeItens: 1,
  quantidades: { solicitada: 1, aprovada: 1, entregue: 0, restante: 1 }, criadaEm: '2026-10-03T13:05:00.000Z', decididaEm: null, canceladaEm: null, entregueEm: null,
});
function rotasDeSessao(s) {
  const lista = (status) => () => ({ status: 200, corpo: { status: 'ok', solicitacoes: [linha(status)], total: 1, pagina: 1, limite: 20 } });
  return {
    'GET /auth/me': () => (s.logado === false
      ? { status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO', message: 'x' } }
      : { status: 200, corpo: { status: 'ok', usuario: { id: s.usuario, nome: `Pessoa ${s.usuario}`, email: 'pessoa@example.invalid', perfil: s.perfil }, empresa: { id: s.empresa, nome: `Empresa ${s.empresa}`, cnpj: '00000000000000' } } }),
    'GET /auth/global/me': () => ({ status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }, { id: 4 }] } }),
    'GET /auth/permissoes': () => ({ status: 200, corpo: s.permissoes }),
    'GET /solicitacoes-epi/minhas': lista('PENDENTE'),
    'GET /solicitacoes-epi/fila': lista('PENDENTE'),
    'GET /solicitacoes-epi/entregaveis': lista('APROVADA'),
  };
}

const TELAS = [
  ['request.html', 'request', { recursos: { request: { ...NENHUMA, visualizar: true, criar: true } } }],
  ['supervisor-approval.html', 'supervisorApproval', { acoes: { APROVAR_SOLICITACAO: true, REPROVAR_SOLICITACAO: true } }],
  ['stock-requests.html', 'stockRequests', { acoes: { REALIZAR_ENTREGA: true, ENCERRAR_SOLICITACAO: true } }],
];

describe('volta pelo histórico nas três telas da solicitação: o que mudou na sessão nunca deixa a página antiga à mostra', () => {
  async function abrirTela(arquivo, concessao) {
    const s = { logado: true, empresa: 3, usuario: 7, perfil: 'ADMINISTRADOR' };
    s.permissoes = permissoes({ ...concessao });
    const pg = abrirPagina(`pages/${arquivo}`, { rotas: rotasDeSessao(s) });
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), true, `${arquivo}: abriu`);
    assert.ok(pg.textoDoDom().includes('Ana Sintética'), `${arquivo}: a lista da sessão anterior está na tela`);
    return { pg, s };
  }
  async function voltar(pg) {
    await pg.eventoDaJanela('pageshow', { persisted: true });
    await pg.esperar();
  }
  function semNadaDaSessaoAnterior(pg, arquivo) {
    assert.equal(pg.visivel('conteudoProtegido'), false, `${arquivo}: conteúdo fechado`);
    assert.equal(pg.visivel('telaSessao'), true, `${arquivo}: a tela de verificação cobre a página`);
    assert.equal(pg.textoDoDom().includes('Ana Sintética'), false, `${arquivo}: os dados da sessão anterior saíram da tela`);
  }

  for (const [arquivo, pagina, concessao] of TELAS) {
    test(`${arquivo}: troca de empresa em outra aba → dados limpos e a página recarrega no contexto atual`, async () => {
      const { pg, s } = await abrirTela(arquivo, concessao);
      s.empresa = 4;
      s.permissoes = permissoes({ empresa: 4, ...concessao });
      await voltar(pg);
      assert.deepEqual(pg.navegacoes, [`/pages/${arquivo}`]);
      semNadaDaSessaoAnterior(pg, arquivo);
    });

    test(`${arquivo}: outra pessoa entrou na mesma empresa → dados limpos e a página recarrega`, async () => {
      const { pg, s } = await abrirTela(arquivo, concessao);
      s.usuario = 8;
      s.permissoes = permissoes({ usuario: 8, ...concessao });
      await voltar(pg);
      assert.deepEqual(pg.navegacoes, [`/pages/${arquivo}`]);
      semNadaDaSessaoAnterior(pg, arquivo);
    });

    test(`${arquivo}: sessão encerrada → Portal, sem a página antiga`, async () => {
      const { pg, s } = await abrirTela(arquivo, concessao);
      s.logado = false;
      await voltar(pg);
      assert.deepEqual(pg.navegacoes, ['../portal/index.html']);
      semNadaDaSessaoAnterior(pg, arquivo);
    });

    test(`${arquivo}: permissão retirada → o item some do menu e a página recarrega, sem a página antiga`, async () => {
      const { pg, s } = await abrirTela(arquivo, concessao);
      s.permissoes = permissoes();
      await voltar(pg);
      assert.deepEqual(pg.navegacoes, [`/pages/${arquivo}`]);
      assert.equal(pg.visivelNo(pg.consulta(`.nav a[data-pagina="${pagina}"]`)[0]), false);
      semNadaDaSessaoAnterior(pg, arquivo);
    });
  }
});
