'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina, RAIZ } = require('./helpers/dom-pagina');

/**
 * 12G-1 — estados padrão das páginas integradas (carregando, vazio, erro,
 * acesso negado, sessão inválida, revalidação e "em integração") e a abertura
 * protegida: o conteúdo só aparece depois de a sessão e as permissões serem
 * confirmadas no servidor, e some quando a sessão termina. Página de teste
 * mínima, com o CSS real, os módulos reais e a rede simulada pelo harness.
 */

const MODULO = 'js/estado-pagina.js';
const CONTEXTO = { status: 'ok', usuario: { id: 7, nome: 'Pessoa Teste', email: 'pessoa@example.invalid', perfil: 'USUARIO' }, empresa: { id: 3, nome: 'Empresa Teste', cnpj: '00000000000000' } };
const area = (v) => ({ consultar: v, alterar: v });
const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
function permissoes({ request = NENHUMA, empresaId = 3, usuarioId = 7, perfil = 'USUARIO' } = {}) {
  return {
    status: 'ok', empresaId, usuarioId, perfil, recursos: { request }, acoes: {},
    administracao: {
      gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false),
      autorizacoesIndividuais: { consultar: true, concederDireta: false, delegar: false }, vinculosSst: area(false),
    },
  };
}
const SO_VER = { ...NENHUMA, visualizar: true };

const HTML = `<!DOCTYPE html><html lang="pt-BR"><head><meta charset="UTF-8"><link rel="stylesheet" href="../css/main.css"></head><body>
<div id="telaSessao"><p id="telaSessaoMensagem">Verificando sua sessão…</p><a id="telaSessaoPortal" href="../portal/index.html" style="display:none">Portal</a></div>
<nav class="nav"><a href="request.html" data-pagina="request" style="display:none">Pedido de EPI</a><a href="materials.html" data-pagina="materials" style="display:none">Gestão de estoque</a></nav>
<div id="estadoPagina" style="display:none"></div>
<div id="conteudoProtegido" style="display:none"><p id="dadoProtegido">conteúdo que só aparece com permissão</p></div>
<div id="avulso"></div>
<script src="../js/api-http.js"></script>
<script src="../portal/config.js"></script>
<script src="../js/sessao-empresarial.js"></script>
<script src="../js/permissoes-efetivas.js"></script>
<script src="../js/estado-pagina.js"></script>
<script>
  EpiHttp.configurar({ baseUrl: window.SAFEWORK_PORTAL_API_BASE_URL });
  window.resultado = 'pendente';
  window.encerrou = 0;
  window.aberta = EpiEstadoPagina.montarPaginaProtegida({
    pagina: 'request',
    elementos: {
      tela: document.getElementById('telaSessao'),
      mensagem: document.getElementById('telaSessaoMensagem'),
      linkPortal: document.getElementById('telaSessaoPortal'),
      conteudo: document.getElementById('conteudoProtegido'),
      estado: document.getElementById('estadoPagina'),
      links: document.querySelectorAll('.nav a[data-pagina]'),
    },
    aoEncerrar: function () { window.encerrou += 1; },
  }).then(function (r) { window.resultado = r; });
</script>
</body></html>`;

function abrir(rotas) {
  assert.ok(fs.existsSync(path.join(RAIZ, MODULO)), `comportamento ausente: ${MODULO} (estados padrão e abertura protegida) não existe`);
  return abrirPagina('pages/teste-estado-12g1.html', { html: HTML, rotas });
}
const rotasOk = (p = permissoes({ request: SO_VER })) => ({
  'GET /auth/me': { status: 200, corpo: CONTEXTO },
  'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
  'GET /auth/permissoes': { status: 200, corpo: p },
});
const estadoAtual = (pg) => {
  const lista = pg.consulta('#estadoPagina [data-estado]');
  return lista.length === 0 ? null : lista[0].getAttribute('data-estado');
};

describe('mostrar: um estado por vez, acessível e só como texto', () => {
  test('cada tipo: papel, aviso ao leitor de tela, ícone decorativo e a mensagem padrão ou a informada', async () => {
    const pg = abrir(rotasOk());
    await pg.esperar();
    const E = pg.janela.EpiEstadoPagina;
    const avulso = pg.el('avulso');
    const esperado = {
      carregando: ['status', 'polite', 'true'], vazio: ['status', 'polite', null], erro: ['alert', 'assertive', null],
      'acesso-negado': ['alert', 'assertive', null], 'sessao-invalida': ['alert', 'assertive', null],
      revalidando: ['status', 'polite', 'true'], 'em-integracao': ['status', 'polite', null],
    };
    assert.deepEqual(Object.values(E.TIPOS).sort(), Object.keys(esperado).sort());
    for (const [tipo, [papel, aoVivo, ocupado]] of Object.entries(esperado)) {
      E.mostrar(avulso, tipo);
      const itens = pg.consulta('#avulso [data-estado]');
      assert.equal(itens.length, 1, `${tipo}: um estado por vez`);
      assert.deepEqual([itens[0].getAttribute('role'), itens[0].getAttribute('aria-live'), itens[0].getAttribute('aria-busy')], [papel, aoVivo, ocupado], tipo);
      assert.equal(pg.consulta('#avulso [aria-hidden="true"]').length, 1, `${tipo}: ícone decorativo`);
      assert.ok(avulso.textContent.includes(E.MENSAGENS[tipo]), tipo);
      assert.equal(pg.visivel('avulso'), true);
    }
    E.mostrar(avulso, 'vazio', 'Nenhuma solicitação.');
    assert.ok(avulso.textContent.includes('Nenhuma solicitação.'));
  });

  test('a mensagem é texto: marcação vinda de fora nunca vira elemento, e nada passa por innerHTML', async () => {
    const pg = abrir(rotasOk());
    await pg.esperar();
    pg.janela.EpiEstadoPagina.mostrar(pg.el('avulso'), 'erro', '<img src=x onerror=alert(1)>');
    assert.equal(pg.consulta('#avulso img').length, 0);
    assert.ok(pg.el('avulso').textContent.includes('<img src=x onerror=alert(1)>'));
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
  });

  test('tipo desconhecido é erro de programação; limpar esvazia e esconde', async () => {
    const pg = abrir(rotasOk());
    await pg.esperar();
    const E = pg.janela.EpiEstadoPagina;
    assert.throws(() => E.mostrar(pg.el('avulso'), 'qualquer'), (e) => e.name === 'TypeError');
    E.mostrar(pg.el('avulso'), 'vazio');
    E.limpar(pg.el('avulso'));
    assert.deepEqual([pg.consulta('#avulso [data-estado]').length, pg.visivel('avulso')], [0, false]);
  });
});

describe('montarPaginaProtegida: nada protegido antes da confirmação no servidor', () => {
  test('sessão e permissão confirmadas: o conteúdo aparece, o estado some, o menu segue a permissão e a ordem é sessão -> permissões', async () => {
    const pg = abrir(rotasOk());
    await pg.esperar();
    assert.deepEqual(pg.chamadas.map((c) => c.chave), ['GET /auth/me', 'GET /auth/global/me', 'GET /auth/permissoes']);
    assert.equal(pg.visivel('conteudoProtegido'), true);
    assert.equal(estadoAtual(pg), null);
    assert.equal(pg.visivel('telaSessao'), false);
    const [linkPedido, linkEstoque] = pg.consulta('.nav a[data-pagina]');
    assert.deepEqual([pg.visivelNo(linkPedido), pg.visivelNo(linkEstoque)], [true, false]);
    assert.deepEqual([pg.janela.resultado.contexto.usuario.id, pg.janela.resultado.permissoes.empresaId], [7, 3]);
  });

  test('enquanto as permissões não chegam: o conteúdo continua escondido e o estado diz que está verificando', async () => {
    let liberar;
    const pendente = new Promise((r) => { liberar = r; });
    const rotas = { ...rotasOk(), 'GET /auth/permissoes': async () => { await pendente; return { status: 200, corpo: permissoes({ request: SO_VER }) }; } };
    const pg = abrir(rotas);
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), false, 'sem flash do conteúdo protegido');
    assert.equal(estadoAtual(pg), 'carregando');
    assert.equal(pg.janela.resultado, 'pendente');
    liberar();
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), true);
  });

  test('sem acesso ao módulo: estado de acesso negado, conteúdo escondido, nenhum link liberado', async () => {
    const pg = abrir(rotasOk(permissoes()));
    await pg.esperar();
    assert.equal(estadoAtual(pg), 'acesso-negado');
    assert.ok(pg.el('estadoPagina').textContent.includes(pg.janela.EpiPermissoes.MENSAGENS.SEM_ACESSO));
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.equal(pg.consulta('.nav a[data-pagina]').filter(pg.visivelNo).length, 0);
    assert.equal(pg.janela.resultado, null);
  });

  test('MASTER sem concessão de solicitação: acesso negado (o perfil não abre a página)', async () => {
    const master = { ...CONTEXTO, usuario: { ...CONTEXTO.usuario, perfil: 'MASTER' } };
    const pg = abrir({ ...rotasOk(permissoes({ perfil: 'MASTER' })), 'GET /auth/me': { status: 200, corpo: master } });
    await pg.esperar();
    assert.equal(estadoAtual(pg), 'acesso-negado');
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });

  test('falha ao consultar as permissões ou resposta de outro contexto: estado de erro, nada liberado', async () => {
    for (const [rota, mensagem] of [
      [{ status: 500, corpo: { status: 'error', codigo: 'ERRO_INTERNO', message: 'x' } }, 'FALHA'],
      [{ status: 200, corpo: permissoes({ request: SO_VER, empresaId: 4 }) }, 'CONTEXTO_DIVERGENTE'],
      [{ status: 200, corpo: { status: 'ok', empresaId: 3 } }, 'FALHA'],
    ]) {
      const pg = abrir({ ...rotasOk(), 'GET /auth/permissoes': rota });
      await pg.esperar();
      assert.equal(estadoAtual(pg), 'erro', mensagem);
      assert.ok(pg.el('estadoPagina').textContent.includes(pg.janela.EpiPermissoes.MENSAGENS[mensagem]), mensagem);
      assert.equal(pg.visivel('conteudoProtegido'), false, mensagem);
    }
  });

  test('sem sessão: vai ao Portal sem consultar permissões; conteúdo nunca aparece', async () => {
    const pg = abrir({ ...rotasOk(), 'GET /auth/me': { status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' } } });
    await pg.esperar();
    assert.deepEqual(pg.chamadas.map((c) => c.chave), ['GET /auth/me']);
    assert.deepEqual(pg.navegacoes, ['../portal/index.html']);
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });

  test('sessão encerrada entre a confirmação e as permissões (401): estado de sessão inválida e Portal', async () => {
    const pg = abrir({ ...rotasOk(), 'GET /auth/permissoes': { status: 401, corpo: { status: 'error', codigo: 'SESSAO_INVALIDA', message: 'x' } } });
    await pg.esperar();
    assert.equal(estadoAtual(pg), 'sessao-invalida');
    assert.deepEqual(pg.navegacoes, ['../portal/index.html']);
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });

  test('401 durante o uso: sessaoEncerrada esconde o conteúdo, mostra o estado e leva ao Portal', async () => {
    const pg = abrir(rotasOk());
    await pg.esperar();
    pg.janela.EpiEstadoPagina.sessaoEncerrada({ conteudo: pg.el('conteudoProtegido'), estado: pg.el('estadoPagina') });
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.equal(estadoAtual(pg), 'sessao-invalida');
    assert.deepEqual(pg.navegacoes, ['../portal/index.html']);
  });

  test('restauração pelo histórico (BFCache) com outra sessão: o conteúdo some antes de recarregar; com a mesma, continua', async () => {
    const mesma = abrir(rotasOk());
    await mesma.esperar();
    await mesma.eventoDaJanela('pageshow', { persisted: true });
    assert.deepEqual([mesma.visivel('conteudoProtegido'), mesma.janela.encerrou, mesma.navegacoes], [true, 0, []]);

    let outra = false;
    const rotas = { ...rotasOk(), 'GET /auth/me': () => ({ status: 200, corpo: outra ? { ...CONTEXTO, usuario: { ...CONTEXTO.usuario, id: 8 } } : CONTEXTO }) };
    const pg = abrir(rotas);
    await pg.esperar();
    outra = true;
    await pg.eventoDaJanela('pageshow', { persisted: true });
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.equal(pg.janela.encerrou, 1, 'a página limpa o que mostrava');
    assert.equal(pg.navegacoes.length, 1, 'recarrega para a sessão atual');
  });

  test('nenhum armazenamento do navegador além da limpeza do protótipo; nada de innerHTML', async () => {
    const pg = abrir(rotasOk());
    await pg.esperar();
    assert.deepEqual(pg.storage.filter((s) => !(s.operacao === 'removeItem' || s.storage === 'cookie')), []);
    assert.deepEqual(pg.documento.usosDeInnerHTML, []);
  });
});
