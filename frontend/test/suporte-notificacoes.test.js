'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina, scriptsDe, semComentarios } = require('./helpers/dom-pagina');

/**
 * Alertas de novas respostas do Suporte no Painel do Cliente: bolinha no menu sanduíche e contador no item "Suporte" do menu
 * lateral, alimentados por GET /suporte/notificacoes (só a QUANTIDADE de chamados com resposta não lida; nada de texto).
 * O módulo js/suporte-notificacoes.js é acionado pelo ponto central do menu (ajustarMenuSuporte) em toda página integrada.
 */

const RAIZ = path.join(__dirname, '..');
const ler = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');
const N = require('../js/suporte-notificacoes');

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = ({ empresaId = 3, usuarioId = 7 } = {}) => ({
  status: 'ok', empresaId, usuarioId, perfil: 'USUARIO',
  recursos: { companyData: { ...NENHUMA }, dashboard: { ...NENHUMA, visualizar: true } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), vinculosSst: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false },
  },
});
const contexto = ({ empresaId = 3, usuarioId = 7 } = {}) => ({
  status: 'ok',
  usuario: { id: usuarioId, nome: 'Eva Teste', email: 'eva@example.invalid', perfil: 'USUARIO' },
  empresa: { id: empresaId, nome: 'Empresa Alfa Ltda', cnpj: '11222333000181' },
  preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const chamado = (extra = {}) => ({
  id: 11, protocolo: 'SUP-2026-000011', assunto: 'Erro ao salvar', categoria: 'ERRO', descricao: 'A tela trava.', situacao: 'RESPONDIDO',
  criadoEm: '2026-10-26T12:00:00.000Z', atualizadoEm: '2026-10-26T12:00:00.000Z', encerradoEm: null, naoLidas: 2, ...extra,
});

function mundo({ naoLidos = 0, rotas = {}, ids = {} } = {}) {
  const estado = { naoLidos, consultas: 0 };
  return {
    estado,
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto(ids) },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: ids.empresaId || 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes(ids) },
      'GET /suporte/canais': { status: 200, corpo: { status: 'ok', canais: { almoxarifado: { configurado: true }, sst: { configurado: true } } } },
      'GET /suporte/chamados': () => ({ status: 200, corpo: { status: 'ok', itens: [chamado()], total: 1, pagina: 1, limite: 20 } }),
      'GET /suporte/chamados/11': () => {
        estado.naoLidos = Math.max(0, estado.naoLidos - 1);
        return { status: 200, corpo: { status: 'ok', chamado: chamado({ naoLidas: 0 }), mensagens: [], historico: [], respostas: [] } };
      },
      'GET /suporte/notificacoes': () => { estado.consultas += 1; return { status: 200, corpo: { status: 'ok', chamadosNaoLidos: estado.naoLidos } }; },
      ...rotas,
    },
  };
}
async function pronta(arquivo, opcoes = {}) {
  const m = mundo(opcoes);
  const pg = abrirPagina(arquivo, { rotas: m.rotas });
  await pg.esperar();
  await pg.esperar();
  await pg.esperar();
  return Object.assign(pg, { estado: m.estado });
}
const consultas = (pg) => pg.chamadas.filter((c) => c.chave === 'GET /suporte/notificacoes');
const botaoMenu = (pg) => pg.consulta('.mobile-global-menu')[0];
const bolinha = (pg) => botaoMenu(pg).querySelector('.menu-alerta');
const linkSuporte = (pg) => pg.consulta('.nav a').find((a) => a.getAttribute('data-suporte') === 'true' || a.getAttribute('data-pagina') === 'support');
const contador = (pg) => linkSuporte(pg).querySelector('.nav-contador');
const visivelEl = (el) => el !== null && el !== undefined && el.style.display !== 'none' && !el.hidden;
async function disparar(pg, tipo) {
  for (const fn of (pg.documento.ouvintes[tipo] || []).slice()) await fn({ type: tipo });
  await pg.esperar();
  await pg.esperar();
}

describe('módulo (sem página)', () => {
  test('modelo.contagem: só aceita a quantidade inteira não negativa do servidor; qualquer outra coisa é null (nunca inventar contagem)', () => {
    assert.equal(N.modelo.contagem({ status: 'ok', chamadosNaoLidos: 0 }), 0);
    assert.equal(N.modelo.contagem({ status: 'ok', chamadosNaoLidos: 7 }), 7);
    for (const ruim of [null, undefined, {}, { chamadosNaoLidos: -1 }, { chamadosNaoLidos: 1.5 }, { chamadosNaoLidos: '2' }, { chamadosNaoLidos: NaN }, 'x']) {
      assert.equal(N.modelo.contagem(ruim), null, JSON.stringify(ruim));
    }
  });
  test('textos acessíveis: singular e plural, sem texto de mensagem', () => {
    assert.equal(N.TEXTOS.descricao(1), '1 chamado de suporte com resposta não lida');
    assert.equal(N.TEXTOS.descricao(3), '3 chamados de suporte com respostas não lidas');
    assert.equal(N.INTERVALO_MS, 30000);
  });
  test('o módulo não persiste nada no navegador e não usa som nem notificação do sistema', () => {
    const codigo = semComentarios(ler('js/suporte-notificacoes.js'));
    assert.doesNotMatch(codigo, /localStorage|sessionStorage|document\.cookie|indexedDB|new Notification|Notification\.|Audio\(|vibrate/);
    assert.doesNotMatch(codigo, /innerHTML|outerHTML|insertAdjacentHTML/);
  });
  test('toda página integrada com o menu carrega o módulo logo depois de permissoes-efetivas.js; nenhuma legada o carrega; está na allowlist', () => {
    const paginas = fs.readdirSync(path.join(RAIZ, 'pages')).filter((f) => f.endsWith('.html')).sort();
    const integradas = [];
    for (const p of paginas) {
      const html = ler(`pages/${p}`);
      const scripts = scriptsDe(html).filter((s) => s.src).map((s) => s.src);
      if (scripts.includes('../js/permissoes-efetivas.js')) {
        integradas.push(p);
        assert.equal(scripts[scripts.indexOf('../js/permissoes-efetivas.js') + 1], '../js/suporte-notificacoes.js', p);
      } else {
        assert.ok(!scripts.includes('../js/suporte-notificacoes.js'), `${p} é legada e não carrega o módulo`);
      }
    }
    assert.equal(integradas.length, 21); // + lgpd.html (Privacidade e LGPD de consulta)
    assert.ok(JSON.parse(ler('publicacao/allowlist.json')).arquivos.includes('js/suporte-notificacoes.js'));
    assert.match(ler('js/permissoes-efetivas.js'), /EpiSuporteNotificacoes\.sincronizar\(/, 'o ponto central do menu aciona o módulo');
  });
});

describe('na página de Suporte (menu + sanduíche)', () => {
  const ARQUIVO = 'pages/support.html';

  test('1. nenhuma resposta não lida: consulta UMA vez depois da sessão e das permissões; bolinha e contador ficam ocultos; rótulo do botão intacto', async () => {
    const pg = await pronta(ARQUIVO, { naoLidos: 0 });
    const chaves = pg.chamadas.map((c) => c.chave);
    assert.equal(consultas(pg).length, 1);
    assert.ok(chaves.indexOf('GET /auth/permissoes') < chaves.indexOf('GET /suporte/notificacoes'), 'só depois das permissões');
    assert.ok(bolinha(pg), 'o elemento existe');
    assert.equal(visivelEl(bolinha(pg)), false);
    assert.equal(visivelEl(contador(pg)), false);
    assert.equal(botaoMenu(pg).getAttribute('aria-label'), 'Abrir menu');
    assert.deepEqual(pg.temporizadoresPendentes().map((t) => t.ms), [30000], 'próxima consulta em 30 s');
  });

  test('2./3. uma ou várias respostas (em um chamado ou em vários): bolinha visível e contador com a QUANTIDADE DE CHAMADOS do servidor; acessível', async () => {
    const pg = await pronta(ARQUIVO, { naoLidos: 1 });
    assert.equal(visivelEl(bolinha(pg)), true);
    assert.equal(bolinha(pg).getAttribute('aria-hidden'), 'true');
    assert.equal(contador(pg).textContent, '1');
    assert.equal(visivelEl(contador(pg)), true);
    assert.equal(botaoMenu(pg).getAttribute('aria-label'), 'Abrir menu. 1 chamado de suporte com resposta não lida');
    assert.equal(linkSuporte(pg).querySelector('.nav-contador-sr').textContent, '1 chamado de suporte com resposta não lida');
    pg.estado.naoLidos = 3;
    await pg.avancar(30000);
    assert.equal(contador(pg).textContent, '3');
    assert.equal(botaoMenu(pg).getAttribute('aria-label'), 'Abrir menu. 3 chamados de suporte com respostas não lidas');
    assert.equal(consultas(pg).length, 2);
    assert.deepEqual(pg.temporizadoresPendentes().map((t) => t.ms), [30000]);
  });

  test('6. abrir o menu sanduíche não consulta nem marca nada como lido; o indicador continua', async () => {
    const pg = await pronta(ARQUIVO, { naoLidos: 2 });
    const antes = pg.chamadas.length;
    pg.janela.toggleSidebar();
    await pg.esperar();
    assert.ok(pg.documento.body.classList.contains('mobile-menu-open'));
    assert.equal(pg.chamadas.length, antes, 'nenhuma requisição ao abrir o menu');
    assert.equal(contador(pg).textContent, '2');
    assert.equal(visivelEl(bolinha(pg)), true);
  });

  test('5. ler uma conversa (o backend marca como lida) atualiza imediatamente; outros chamados continuam contados', async () => {
    const pg = await pronta(ARQUIVO, { naoLidos: 2 });
    assert.equal(contador(pg).textContent, '2');
    const botao = pg.consulta('button[data-chamado="11"]')[0];
    assert.ok(botao, 'botão "Abrir conversa" do chamado 11');
    await botao.disparar('click');
    await pg.esperar();
    await pg.esperar();
    assert.equal(consultas(pg).length, 2, 'consulta imediata depois da leitura');
    assert.equal(contador(pg).textContent, '1');
    assert.equal(visivelEl(bolinha(pg)), true);
    pg.estado.naoLidos = 0;
    await pg.avancar(30000);
    assert.equal(visivelEl(contador(pg)), false);
    assert.equal(visivelEl(bolinha(pg)), false);
    assert.equal(botaoMenu(pg).getAttribute('aria-label'), 'Abrir menu');
  });

  test('11. página oculta: o ciclo não consulta; ao voltar à aba consulta na hora e retoma o ritmo; nunca duas em voo', async () => {
    let liberar = null;
    const pg = await pronta(ARQUIVO, { naoLidos: 1 });
    pg.documento.visibilityState = 'hidden';
    await disparar(pg, 'visibilitychange');
    await pg.avancar(30000);
    assert.equal(consultas(pg).length, 1, 'oculta: nenhuma consulta');
    assert.equal(pg.temporizadoresPendentes().length, 0, 'oculta: sem temporizador');
    pg.documento.visibilityState = 'visible';
    // A requisição parte (fica registrada em chamadas), mas a resposta só chega quando o teste liberar.
    pg.janela.fetch = ((original) => (url, o) => {
      if (!String(url).includes('/suporte/notificacoes')) return original(url, o);
      const resposta = original(url, o);
      return new Promise((r) => { liberar = () => r(resposta); });
    })(pg.janela.fetch);
    await disparar(pg, 'visibilitychange');
    assert.equal(consultas(pg).length, 2, 'visível de novo: consulta imediata');
    pg.janela.EpiSuporteNotificacoes.atualizarAgora();
    await pg.esperar();
    assert.equal(consultas(pg).length, 2, 'com uma em voo, não dispara outra');
    liberar();
    await pg.esperar();
    await pg.esperar();
    assert.deepEqual(pg.temporizadoresPendentes().map((t) => t.ms), [30000]);
  });

  test('10. falha de conexão: nada muda (nem some nem inventa) e o ciclo continua; resposta inválida também não muda', async () => {
    const pg = await pronta(ARQUIVO, { naoLidos: 2 });
    const original = pg.janela.fetch;
    pg.janela.fetch = (url, o) => (String(url).includes('/suporte/notificacoes') ? Promise.reject(new TypeError('Failed to fetch')) : original(url, o));
    await pg.avancar(30000);
    assert.equal(contador(pg).textContent, '2');
    assert.equal(visivelEl(bolinha(pg)), true);
    assert.deepEqual(pg.temporizadoresPendentes().map((t) => t.ms), [30000], 'tenta de novo no próximo ciclo');
    pg.janela.fetch = original;
    pg.estado.naoLidos = 'x';
    await pg.avancar(30000);
    assert.equal(contador(pg).textContent, '2', 'contagem inválida é ignorada');
  });

  test('8./9. sessão encerrada (401) ou proibida (403): limpa o indicador e para de consultar', async () => {
    for (const status of [401, 403]) {
      const pg = await pronta(ARQUIVO, { naoLidos: 2 });
      assert.equal(contador(pg).textContent, '2');
      const original = pg.janela.fetch;
      const corpo = JSON.stringify({ status: 'error', codigo: status === 401 ? 'SESSAO_INVALIDA' : 'PERMISSAO_NEGADA', message: 'recusado' });
      pg.janela.fetch = (url, o) => (String(url).includes('/suporte/notificacoes')
        ? Promise.resolve({ status, ok: false, text: async () => corpo })
        : original(url, o));
      await pg.avancar(30000);
      assert.equal(visivelEl(contador(pg)), false, String(status));
      assert.equal(visivelEl(bolinha(pg)), false, String(status));
      assert.equal(botaoMenu(pg).getAttribute('aria-label'), 'Abrir menu');
      assert.equal(pg.temporizadoresPendentes().length, 0, `${status}: sem novas consultas`);
    }
  });

  test('7. troca de empresa ou usuário na revalidação: o indicador é limpo e reconsultado; resposta atrasada da identidade anterior é descartada', async () => {
    let segurar = null;
    const pg = await pronta(ARQUIVO, { naoLidos: 4 });
    assert.equal(contador(pg).textContent, '4');
    const original = pg.janela.fetch;
    let lenta = true;
    pg.janela.fetch = (url, o) => {
      if (String(url).includes('/suporte/notificacoes') && lenta) {
        lenta = false;
        const resposta = original(url, o); // registrada agora (identidade 3:7, contagem 4); entregue só em segurar()
        return new Promise((r) => { segurar = () => r(resposta); });
      }
      return original(url, o);
    };
    pg.janela.EpiSuporteNotificacoes.atualizarAgora(); // em voo, ainda da identidade 3:7
    await pg.esperar();
    pg.estado.naoLidos = 0;
    pg.janela.EpiSuporteNotificacoes.sincronizar(permissoes({ empresaId: 9, usuarioId: 70 }), pg.documento);
    await pg.esperar();
    assert.equal(visivelEl(contador(pg)), false, 'identidade nova começa limpa');
    assert.equal(visivelEl(bolinha(pg)), false);
    pg.estado.naoLidos = 4;
    segurar(); // a resposta antiga (4) chega depois da troca
    await pg.esperar();
    await pg.esperar();
    assert.equal(pg.janela.EpiSuporteNotificacoes.estado().identidade, '9:70');
    assert.equal(pg.janela.EpiSuporteNotificacoes.estado().contagem, 4, 'a consulta da identidade nova leu 4 do servidor');
    pg.janela.EpiSuporteNotificacoes.sincronizar(null, pg.documento);
    assert.equal(visivelEl(contador(pg)), false, 'sem sessão: limpo');
    assert.equal(pg.temporizadoresPendentes().length, 0);
  });
});

describe('em outra página integrada (Dashboard): o item "Suporte" ajustado centralmente recebe o contador', () => {
  test('12./13. desktop e móvel usam o mesmo menu: contador no item Suporte (href support.html, sem "Em integração") e bolinha no sanduíche', async () => {
    const pg = await pronta('pages/dashboard.html', { naoLidos: 2 });
    const a = linkSuporte(pg);
    assert.ok(a, 'item Suporte ajustado');
    assert.equal(a.getAttribute('href'), 'support.html');
    assert.equal(a.getAttribute('aria-disabled'), null);
    assert.equal(a.querySelectorAll('.nav-etiqueta').length, 0, 'sem "Em integração"');
    assert.equal(contador(pg).textContent, '2');
    assert.equal(visivelEl(bolinha(pg)), true);
    assert.equal(consultas(pg).length, 1);
  });
});
