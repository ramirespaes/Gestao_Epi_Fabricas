'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { abrirPagina, RAIZ } = require('./helpers/dom-painel');

/**
 * Painel Privado — atendimento dos chamados de suporte como CONVERSA (painel-privado/suporte.html). Sessão administrativa própria
 * (nunca a empresarial), nada visível antes da confirmação, texto só por textContent, ações idempotentes por clique único,
 * mensagens dos dois lados, não lidas vindas do servidor, sondagem só com a conversa aberta, ENCERRADO só sai por reabertura.
 */

const PAGINA = 'painel-privado/suporte.html';
const ok = (corpo = {}) => ({ status: 200, corpo: { status: 'ok', ...corpo } });
const erro = (status, codigo, message = 'x') => ({ status, corpo: { status: 'error', codigo, message } });
const msg = (id, autor, texto) => ({ id, autor, texto, criadoEm: `2026-10-26T12:0${id}:00.000Z` });
const chamado = (extra = {}) => ({
  id: 5, protocolo: 'SUP-2026-000005', assunto: 'Erro ao salvar', categoria: 'ERRO', descricao: 'A tela trava.', situacao: 'ABERTO', naoLidas: 0,
  criadoEm: '2026-10-26T12:00:00.000Z', atualizadoEm: '2026-10-26T12:00:00.000Z', encerradoEm: null,
  empresa: { id: 3, nome: 'Empresa Alfa Ltda', cnpj: '11222333000181' }, solicitante: { nome: 'Eva Teste', email: 'eva@example.invalid' }, ...extra,
});

function servidor({ itens = [chamado()], mensagens = [], rotas = {} } = {}) {
  const estado = {
    chamado: chamado(), mensagens: [...mensagens], historico: [{ id: 1, de: null, para: 'ABERTO', criadoEm: '2026-10-26T12:00:00.000Z' }], posts: [], patches: [], listagens: [],
  };
  const corpoDetalhe = () => ok({ chamado: estado.chamado, mensagens: estado.mensagens, historico: estado.historico });
  return {
    estado,
    rotas: {
      'GET /auth/me': ok(),
      'GET /suporte/chamados': (c) => { estado.listagens.push(c.url); return ok({ itens, total: itens.length, pagina: 1, limite: 20 }); },
      'GET /suporte/chamados/5': corpoDetalhe,
      'GET /suporte/chamados/5/mensagens': (c) => {
        const apos = Number(new URL(c.url).searchParams.get('aposId') || 0);
        return ok({ situacao: estado.chamado.situacao, encerradoEm: estado.chamado.encerradoEm, mensagens: estado.mensagens.filter((m) => m.id > apos) });
      },
      'POST /suporte/chamados/5/respostas': (c) => {
        estado.posts.push(c.corpo);
        const m = msg(estado.mensagens.length + 1, 'SAFEWORK', c.corpo.texto);
        estado.mensagens.push(m);
        estado.historico.push({ id: 2, de: estado.chamado.situacao, para: 'RESPONDIDO', criadoEm: '2026-10-26T13:00:00.000Z' });
        estado.chamado = { ...estado.chamado, situacao: 'RESPONDIDO' };
        return { status: 201, corpo: { status: 'ok', resposta: m, mensagem: m, situacao: 'RESPONDIDO', repetido: false } };
      },
      'PATCH /suporte/chamados/5/situacao': (c) => {
        estado.patches.push(c.corpo);
        const anterior = estado.chamado.situacao;
        if (anterior === 'ENCERRADO' && c.corpo.situacao !== 'ABERTO') return erro(409, 'CHAMADO_ENCERRADO');
        estado.chamado = { ...estado.chamado, situacao: c.corpo.situacao, encerradoEm: c.corpo.situacao === 'ENCERRADO' ? '2026-10-26T14:00:00.000Z' : null };
        estado.historico.push({ id: 3, de: anterior, para: c.corpo.situacao, criadoEm: '2026-10-26T14:00:00.000Z' });
        return ok({ situacao: c.corpo.situacao, alterado: true });
      },
      ...rotas,
    },
  };
}
async function abrir(srv) {
  const pg = abrirPagina(PAGINA, { rotas: srv.rotas });
  await pg.esperar();
  return pg;
}
async function abrirDetalhe(pg) {
  await pg.el('lista').disparar('click', { target: { closest: () => ({ getAttribute: () => '5' }) } });
  await pg.esperar();
}
const doTipo = (pg, chave) => pg.chamadas.filter((c) => c.chave === chave);
const bolhas = (pg) => pg.el('det-conversa').children.filter((n) => n.getAttribute('data-mensagem')).map((n) => [n.getAttribute('data-autor'), n.textContent]);
const sondar = async (pg) => { await pg.janela.SafeworkSuporteAtendimento.sondarAgora(); await pg.esperar(); };

describe('sessão administrativa e visibilidade', () => {
  test('o conteúdo nasce oculto; sem sessão (401) vai ao login e nenhuma rota do Suporte é consultada', async () => {
    const html = fs.readFileSync(path.join(RAIZ, PAGINA), 'utf8');
    assert.match(html, /<main id="conteudo" style="display:none;">/);
    const pg = abrirPagina(PAGINA, { rotas: { 'GET /auth/me': erro(401, 'NAO_AUTENTICADO') } });
    await pg.esperar();
    assert.deepEqual(pg.navegacoes, ['index.html']);
    assert.match(pg.el('conteudo').getAttribute('style'), /display:none/);
    assert.notEqual(pg.el('conteudo').style.display, 'block');
    assert.equal(pg.chamadas.filter((c) => c.chave.includes('/suporte')).length, 0);
  });

  test('com sessão válida: confirma em /auth/me ANTES de listar, e só então mostra o conteúdo; usa credentials include e nada vai ao armazenamento', async () => {
    const pg = await abrir(servidor());
    const ordem = pg.chamadas.map((c) => c.chave);
    assert.ok(ordem.indexOf('GET /auth/me') < ordem.indexOf('GET /suporte/chamados'));
    assert.equal(pg.el('conteudo').style.display, 'block');
    assert.ok(pg.chamadas.every((c) => c.credentials === 'include'));
    assert.deepEqual(pg.storage, []);
    assert.equal(pg.externas.length, 0);
  });

  test('a lista mostra protocolo, empresa, situação e a marca de mensagens novas (vinda do servidor); o filtro "só com mensagens novas" vai por query', async () => {
    const pg = await abrir(servidor({ itens: [chamado({ naoLidas: 2 })] }));
    assert.match(pg.el('lista').textContent, /SUP-2026-000005/);
    assert.match(pg.el('lista').textContent, /Empresa Alfa Ltda/);
    assert.match(pg.el('lista').textContent, /2 mensagens novas/);
    await pg.marcar('filtro-nao-lidas', true);
    assert.match(doTipo(pg, 'GET /suporte/chamados').at(-1).url, /naoLidas=true/);
    const expirado = await abrir(servidor({ rotas: { 'GET /suporte/chamados': erro(401, 'NAO_AUTENTICADO') } }));
    assert.ok(expirado.navegacoes.includes('index.html'));
  });

  test('"Sair" e a volta pelo histórico (BFCache) escondem tudo, param a sondagem e confirmam a sessão de novo', async () => {
    const srv = servidor();
    srv.rotas['POST /auth/logout'] = ok();
    const pg = await abrir(srv);
    await abrirDetalhe(pg);
    assert.equal(pg.el('detalhe').style.display, 'block');
    assert.equal(pg.janela.SafeworkSuporteAtendimento.conversaAberta(), 5);
    await pg.eventoDaJanela('pageshow', { persisted: true });
    assert.equal(pg.el('detalhe').style.display, 'none', 'o detalhe some até a sessão ser reconfirmada');
    assert.equal(pg.janela.SafeworkSuporteAtendimento.conversaAberta(), null, 'sondagem parada');
    assert.equal(pg.el('titulo-detalhe').textContent, 'Atendimento');
    assert.equal(doTipo(pg, 'GET /auth/me').length, 2, 'a sessão é confirmada de novo');
    await pg.clicar('sair');
    assert.equal(pg.el('conteudo').style.display, 'none');
    assert.ok(pg.navegacoes.includes('index.html'));
  });
});

describe('conversa, resposta e situação', () => {
  test('o detalhe mostra empresa, solicitante, descrição, a conversa com os DOIS lados diferenciados e o histórico; tudo entra como texto (XSS)', async () => {
    const carga = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const srv = servidor({ itens: [chamado({ assunto: carga, empresa: { id: 3, nome: carga, cnpj: '1' } })], mensagens: [msg(1, 'SOLICITANTE', carga), msg(2, 'SAFEWORK', 'ok')] });
    srv.estado.chamado = chamado({ assunto: carga, descricao: carga, empresa: { id: 3, nome: carga, cnpj: '1' }, solicitante: { nome: carga, email: 'e@x.test' } });
    const pg = await abrir(srv);
    await abrirDetalhe(pg);
    assert.ok(pg.el('det-descricao').textContent.includes(carga));
    assert.ok(pg.el('det-empresa').textContent.includes(carga));
    assert.ok(pg.el('det-solicitante').textContent.includes(carga));
    const b = bolhas(pg);
    assert.deepEqual(b.map((x) => x[0]), ['SOLICITANTE', 'SAFEWORK']);
    assert.match(b[0][1], /^Solicitante · /);
    assert.ok(b[0][1].includes(carga));
    assert.match(b[1][1], /^SafeWork · /);
    assert.equal(pg.documento.usosDeInnerHTML.length, 0, 'nenhum innerHTML');
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(/.test(fs.readFileSync(path.join(RAIZ, 'painel-privado/suporte.js'), 'utf8')), false);
  });

  test('responder envia { texto, chaveIdempotencia }, uma vez; o chamado passa a Respondido com a mensagem e o histórico relidos; a chave muda depois do sucesso', async () => {
    const srv = servidor();
    const pg = await abrir(srv);
    await abrirDetalhe(pg);
    await pg.digitar('resposta-texto', '  Já corrigimos.  ');
    await pg.enviar('form-resposta');
    assert.equal(srv.estado.posts.length, 1);
    assert.deepEqual(Object.keys(srv.estado.posts[0]).sort(), ['chaveIdempotencia', 'texto']);
    assert.equal(srv.estado.posts[0].texto, 'Já corrigimos.');
    assert.match(srv.estado.posts[0].chaveIdempotencia, /^[0-9a-f-]{36}$/);
    assert.match(pg.el('det-situacao').textContent, /Respondido/);
    assert.deepEqual(bolhas(pg).map((x) => x[0]), ['SAFEWORK']);
    assert.match(pg.el('det-historico').textContent, /Respondido/);
    assert.match(pg.el('msg-detalhe').textContent, /Resposta enviada/);
    assert.equal(pg.el('resposta-texto').value, '');
    await pg.digitar('resposta-texto', 'Outra');
    await pg.enviar('form-resposta');
    assert.notEqual(srv.estado.posts[0].chaveIdempotencia, srv.estado.posts[1].chaveIdempotencia);
  });

  test('falha de rede ao responder: o texto fica, e o reenvio usa a MESMA chave (sem duplicar)', async () => {
    let falhar = true;
    const srv = servidor();
    const original = srv.rotas['POST /suporte/chamados/5/respostas'];
    srv.rotas['POST /suporte/chamados/5/respostas'] = (c) => (falhar ? new Error('rede') : original(c));
    const pg = await abrir(srv);
    await abrirDetalhe(pg);
    await pg.digitar('resposta-texto', 'oi');
    await pg.enviar('form-resposta');
    assert.equal(pg.el('resposta-texto').value, 'oi');
    assert.match(pg.el('msg-detalhe').textContent, /Não foi possível falar com o servidor/);
    assert.equal(pg.el('btn-responder').disabled, false);
    falhar = false;
    await pg.enviar('form-resposta');
    const posts = doTipo(pg, 'POST /suporte/chamados/5/respostas');
    assert.equal(posts.length, 2);
    assert.equal(posts[0].corpo.chaveIdempotencia, posts[1].corpo.chaveIdempotencia);
  });

  test('resposta vazia ou acima de 4000 não chega à rede', async () => {
    const srv = servidor();
    const pg = await abrir(srv);
    await abrirDetalhe(pg);
    await pg.digitar('resposta-texto', '   ');
    await pg.enviar('form-resposta');
    await pg.digitar('resposta-texto', 'a'.repeat(4001));
    await pg.enviar('form-resposta');
    assert.equal(srv.estado.posts.length, 0);
    assert.match(pg.el('msg-detalhe').textContent, /Escreva a resposta/);
  });

  test('sondagem: pede só o que é mais novo (aposId), acrescenta a mensagem do solicitante SEM tocar no rascunho, avisa, reflete a situação (voltou a Aberto) e relê a fila', async () => {
    const srv = servidor({ mensagens: [msg(1, 'SAFEWORK', 'Pode detalhar?')] });
    srv.estado.chamado = chamado({ situacao: 'RESPONDIDO' });
    const pg = await abrir(srv);
    await abrirDetalhe(pg);
    await pg.digitar('resposta-texto', 'rascunho em andamento');
    const listagensAntes = srv.estado.listagens.length;
    srv.estado.mensagens.push(msg(2, 'SOLICITANTE', 'Acontece ao salvar.'));
    srv.estado.chamado = chamado({ situacao: 'ABERTO' });
    await sondar(pg);
    const sondagens = doTipo(pg, 'GET /suporte/chamados/5/mensagens');
    assert.equal(sondagens.length, 1);
    assert.match(sondagens[0].url, /aposId=1/);
    assert.deepEqual(bolhas(pg).map((x) => x[0]), ['SAFEWORK', 'SOLICITANTE']);
    assert.equal(pg.el('resposta-texto').value, 'rascunho em andamento');
    assert.match(pg.el('det-situacao').textContent, /Aberto/);
    assert.match(pg.el('msg-detalhe').textContent, /nova mensagem/);
    assert.ok(srv.estado.listagens.length > listagensAntes, 'a fila é relida quando chega mensagem');
    await sondar(pg);
    assert.match(doTipo(pg, 'GET /suporte/chamados/5/mensagens').at(-1).url, /aposId=2/);
    assert.equal(bolhas(pg).length, 2, 'nada duplicado');
  });

  test('alterar a situação envia só { situacao }; "sem alteração" é dito, não fingido', async () => {
    const srv = servidor();
    const pg = await abrir(srv);
    await abrirDetalhe(pg);
    pg.el('nova-situacao').value = 'EM_ATENDIMENTO';
    await pg.clicar('btn-situacao');
    assert.deepEqual(srv.estado.patches, [{ situacao: 'EM_ATENDIMENTO' }]);
    assert.match(pg.el('det-situacao').textContent, /Em atendimento/);
    assert.match(pg.el('msg-detalhe').textContent, /Situação atualizada/);
    const sem = servidor({ rotas: { 'PATCH /suporte/chamados/5/situacao': ok({ situacao: 'ABERTO', alterado: false }) } });
    const pg2 = await abrir(sem);
    await abrirDetalhe(pg2);
    await pg2.clicar('btn-situacao');
    assert.match(pg2.el('msg-detalhe').textContent, /já está nessa situação/);
  });

  test('encerrar exige confirmação; cancelar não envia; confirmar envia ENCERRADO, trava o formulário e mostra "Reabrir"; reabrir (com confirmação) envia ABERTO e destrava', async () => {
    const srv = servidor();
    const pg = await abrir(srv);
    await abrirDetalhe(pg);
    await pg.clicar('btn-encerrar');
    assert.equal(srv.estado.patches.length, 0, 'ainda não enviou');
    assert.equal(pg.el('confirmar-encerrar').style.display, '');
    await pg.clicar('btn-cancelar-encerrar');
    assert.equal(srv.estado.patches.length, 0);
    await pg.clicar('btn-encerrar');
    await pg.clicar('btn-confirmar-encerrar');
    assert.deepEqual(srv.estado.patches, [{ situacao: 'ENCERRADO' }]);
    assert.match(pg.el('det-situacao').textContent, /Encerrado/);
    for (const id of ['resposta-texto', 'btn-responder', 'nova-situacao', 'btn-situacao', 'btn-encerrar']) assert.equal(pg.el(id).disabled, true, id);
    assert.equal(pg.el('btn-reabrir').style.display, '');
    assert.equal(pg.el('btn-encerrar').style.display, 'none');
    assert.match(pg.el('msg-detalhe').textContent, /Atendimento encerrado/);
    await pg.clicar('btn-reabrir');
    assert.equal(pg.el('confirmar-reabrir').style.display, '');
    await pg.clicar('btn-confirmar-reabrir');
    assert.deepEqual(srv.estado.patches, [{ situacao: 'ENCERRADO' }, { situacao: 'ABERTO' }]);
    assert.match(pg.el('det-situacao').textContent, /Aberto/);
    assert.equal(pg.el('resposta-texto').disabled, false);
    assert.equal(pg.el('btn-reabrir').style.display, 'none');
    assert.match(pg.el('msg-detalhe').textContent, /reaberto/);
  });

  test('ato GRAVADO mas releitura falha: a tela comunica o sucesso (nunca "falha de rede"), orienta a não reenviar e, no encerramento, trava o formulário pela resposta do PATCH', async () => {
    let falharLeitura = false;
    const srv = servidor();
    const detalheOriginal = srv.rotas['GET /suporte/chamados/5'];
    srv.rotas['GET /suporte/chamados/5'] = (c) => (falharLeitura ? new Error('rede') : detalheOriginal(c));
    const pg = await abrir(srv);
    await abrirDetalhe(pg);
    falharLeitura = true;
    await pg.digitar('resposta-texto', 'Já corrigimos.');
    await pg.enviar('form-resposta');
    assert.equal(srv.estado.posts.length, 1, 'a resposta foi gravada');
    assert.match(pg.el('msg-detalhe').textContent, /Resposta enviada/);
    assert.match(pg.el('msg-detalhe').textContent, /Não reenvie/);
    assert.doesNotMatch(pg.el('msg-detalhe').textContent, /Não foi possível falar com o servidor/);
    await pg.clicar('btn-encerrar');
    await pg.clicar('btn-confirmar-encerrar');
    assert.deepEqual(srv.estado.patches, [{ situacao: 'ENCERRADO' }]);
    assert.match(pg.el('msg-detalhe').textContent, /Atendimento encerrado/);
    for (const id of ['btn-responder', 'btn-situacao', 'btn-encerrar']) assert.equal(pg.el(id).disabled, true, `${id} travado pela resposta do PATCH`);
  });

  test('chamado encerrado por outra pessoa (409): a tela diz o motivo pelo código, relê e trava; nunca mostra o texto do servidor', async () => {
    const srv = servidor({ rotas: { 'POST /suporte/chamados/5/respostas': erro(409, 'CHAMADO_ENCERRADO', 'TEXTO-INTERNO-DO-SERVIDOR') } });
    const pg = await abrir(srv);
    await abrirDetalhe(pg);
    await pg.digitar('resposta-texto', 'oi');
    await pg.enviar('form-resposta');
    assert.equal(pg.textoDoDom().includes('TEXTO-INTERNO-DO-SERVIDOR'), false);
  });

  test('sessão que expira durante uma ação leva ao login', async () => {
    const srv = servidor({ rotas: { 'POST /suporte/chamados/5/respostas': erro(401, 'NAO_AUTENTICADO') } });
    const pg = await abrir(srv);
    await abrirDetalhe(pg);
    await pg.digitar('resposta-texto', 'oi');
    await pg.enviar('form-resposta');
    assert.ok(pg.navegacoes.includes('index.html'));
  });
});

describe('filtros e navegação', () => {
  test('o filtro de situação e a busca vão por query (codificados) e voltam à página 1', async () => {
    const pg = await abrir(servidor());
    pg.el('filtro-situacao').value = 'ABERTO';
    pg.el('busca').value = 'a&b=c';
    await pg.clicar('btn-buscar');
    const ultima = doTipo(pg, 'GET /suporte/chamados').at(-1);
    assert.equal(ultima.temQuery, true);
    assert.match(ultima.url, /busca=a%26b%3Dc/);
  });

  test('o Painel liga a área: link "Suporte" na tela inicial e no menu de Empresas, e a página usa a mesma identidade visual (variáveis do Painel)', () => {
    assert.match(fs.readFileSync(path.join(RAIZ, 'painel-privado/painel.html'), 'utf8'), /href="suporte\.html"/);
    assert.match(fs.readFileSync(path.join(RAIZ, 'painel-privado/empresas.html'), 'utf8'), /href="suporte\.html">Suporte/);
    const html = fs.readFileSync(path.join(RAIZ, PAGINA), 'utf8');
    for (const token of ['--ink: #153333', '--accent: #1f7563', '--logo-fundo: #153333', 'Painel Privado · Administração SafeWork']) assert.ok(html.includes(token), token);
    assert.doesNotMatch(html, /sessao-empresarial|portal\/config|SAFEWORK_PORTAL/, 'autenticação separada: nada da sessão empresarial');
  });

  test('o Painel Privado nunca entra no pacote publicável do cliente', () => {
    const allowlist = require('../publicacao/allowlist.json').arquivos;
    assert.equal(allowlist.some((f) => f.startsWith('painel-privado/')), false);
  });
});
