'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  abrirPagina, semComentariosHtml, scriptsDe, arquivosLocaisDe,
} = require('./helpers/dom-pagina');

/**
 * Suporte — a página pages/support.html no harness de DOM, com API simulada.
 *
 * Duas partes: (1) as CONDIÇÕES que justificam tirá-la da classificação de protótipo (sessão real, sem login demonstrativo, nada antes
 * da validação, sem script externo, tudo na allowlist, sem ação simulada), e (2) o comportamento real dos três canais. A aparência
 * aprovada é guardada pelo conteúdo preservado (cabeçalho, canais, dúvidas) e por css/support.css, que não pode mudar.
 */

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = 'pages/support.html';
const lerArquivo = (rel) => fs.readFileSync(path.join(RAIZ, rel), 'utf8');

const NENHUMA = { visualizar: false, criar: false, editar: false, excluir: false };
const area = (v) => ({ consultar: v, alterar: v });
const permissoes = () => ({
  status: 'ok', empresaId: 3, usuarioId: 7, perfil: 'USUARIO',
  recursos: { companyData: { ...NENHUMA } }, acoes: {},
  administracao: {
    gruposAcesso: area(false), permissoesGrupo: area(false), vinculosGrupo: area(false), usuarios: area(false), vinculosSst: area(false),
    autorizacoesIndividuais: { consultar: false, concederDireta: false, delegar: false },
  },
});
const contexto = () => ({
  status: 'ok',
  usuario: { id: 7, nome: 'Eva Teste', email: 'eva@example.invalid', perfil: 'USUARIO' },
  empresa: { id: 3, nome: 'Empresa Alfa Ltda', cnpj: '11222333000181' },
  preferencias: { tema: 'claro', modoVisual: 'padrao' },
});
const chamado = (extra = {}) => ({
  id: 11, protocolo: 'SUP-2026-000011', assunto: 'Erro ao salvar', categoria: 'ERRO', descricao: 'A tela trava.', situacao: 'ABERTO',
  criadoEm: '2026-10-26T12:00:00.000Z', atualizadoEm: '2026-10-26T12:00:00.000Z', encerradoEm: null, ...extra,
});

function mundo({ canais = { almoxarifado: { configurado: true }, sst: { configurado: false } }, itens = [], rotas = {} } = {}) {
  const estado = { itens: [...itens], posts: [] };
  return {
    estado,
    rotas: {
      'GET /auth/me': { status: 200, corpo: contexto() },
      'GET /auth/global/me': { status: 200, corpo: { status: 'ok', empresas: [{ id: 3 }] } },
      'GET /auth/permissoes': { status: 200, corpo: permissoes() },
      'GET /suporte/canais': { status: 200, corpo: { status: 'ok', canais } },
      'GET /suporte/chamados': () => ({ status: 200, corpo: { status: 'ok', itens: estado.itens, total: estado.itens.length, pagina: 1, limite: 20 } }),
      'POST /suporte/chamados': (c) => {
        estado.posts.push(c.corpo);
        const novo = chamado({ id: 20 + estado.posts.length, protocolo: 'SUP-2026-000099', assunto: c.corpo.assunto, descricao: c.corpo.descricao });
        estado.itens = [novo, ...estado.itens];
        return { status: 201, corpo: { status: 'ok', chamado: novo, repetido: false } };
      },
      ...rotas,
    },
  };
}
async function pronta(opcoes = {}) {
  const m = mundo(opcoes);
  const pg = abrirPagina(ARQUIVO, { rotas: m.rotas });
  await pg.esperar();
  await pg.esperar();
  return Object.assign(pg, { estado: m.estado });
}
const postsDe = (pg, caminho) => pg.chamadas.filter((c) => c.metodo === 'POST' && c.caminho === caminho);

describe('condições para deixar de ser protótipo', () => {
  const html = () => lerArquivo(ARQUIVO);
  const semComentarios = () => semComentariosHtml(html());

  test('não carrega os scripts de protótipo (main.js, db-api.js, inspecao-visual.js) nem handlers inline', () => {
    const codigo = semComentarios();
    assert.doesNotMatch(codigo, /js\/main\.js|js\/db-api\.js|js\/inspecao-visual\.js/);
    assert.doesNotMatch(codigo, /\son(click|keydown|change|submit|load|input)\s*=/i, 'sem manipuladores inline (as ações são ligadas por addEventListener)');
  });

  test('sem login demonstrativo: nada de e-mail/senha, recuperação, biometria, quiosque ou identidade de empresa fixa', () => {
    const codigo = semComentarios();
    for (const proibido of ['loginScreen', 'loginEmail', 'loginPassword', 'doLogin', 'Esqueci minha senha', 'biometri', 'Quiosque', 'kioskPassword', 'Cobresul', 'Simulação:', 'example.invalid']) {
      assert.equal(codigo.toLowerCase().includes(proibido.toLowerCase()), false, `"${proibido}" não pode estar na página`);
    }
    assert.match(codigo, /id="telaSessao"/);
    assert.match(codigo, /js\/sessao-empresarial\.js/);
  });

  test('nenhum script externo (só a fonte de ícones por <link>); todo recurso local carregado está na allowlist de publicação', () => {
    const scripts = scriptsDe(html());
    assert.ok(scripts.length > 0);
    for (const s of scripts) assert.doesNotMatch(String(s.src ?? s), /^https?:|^\/\//i, `script externo: ${s.src ?? s}`);
    const allowlist = new Set(require('../publicacao/allowlist.json').arquivos);
    assert.ok(allowlist.has('pages/support.html'));
    for (const recurso of arquivosLocaisDe(ARQUIVO)) assert.ok(allowlist.has(recurso), `${recurso} precisa estar na allowlist`);
    for (const proibido of ['js/main.js', 'js/db-api.js', 'js/inspecao-visual.js']) assert.equal(allowlist.has(proibido), false);
  });

  test('o conteúdo protegido nasce oculto e a página não faz nenhuma chamada de dados antes da sessão', async () => {
    assert.match(semComentarios(), /<div id="conteudoProtegido" style="display:none">/);
    const pg = abrirPagina(ARQUIVO, { rotas: { 'GET /auth/me': { status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO' } } } });
    await pg.esperar();
    await pg.esperar();
    assert.equal(pg.visivel('conteudoProtegido'), false);
    assert.equal(pg.chamadas.filter((c) => c.caminho.startsWith('/suporte')).length, 0, 'sem sessão, nenhuma rota do Suporte é consultada');
    assert.equal(pg.chamadas.some((c) => c.metodo === 'POST'), false);
  });

  test('o JS do módulo não usa innerHTML nem armazenamento do navegador, e nenhuma ação é simulada (sem alert/confirm/mailto/localStorage)', () => {
    const js = lerArquivo('js/suporte.js');
    assert.equal(/innerHTML|outerHTML|insertAdjacentHTML|localStorage|sessionStorage|document\.cookie|alert\(|confirm\(|mailto:/.test(js), false);
    assert.equal(/localStorage|sessionStorage|mailto:|openSupportModal/.test(semComentarios()), false);
  });

  test('a camada HTTP recusa empresa, usuário, e-mail e destinatário no corpo antes de qualquer rede', () => {
    const S = require('../js/suporte');
    global.EpiHttp = { requisitar: () => { throw new Error('não devia chegar à rede'); } };
    const chave = '4b7f1f5e-5a58-4d0c-9d3a-0b2a7e9c1f11';
    for (const extra of [{ empresaId: 1 }, { usuarioId: 1 }, { email: 'a@b.test' }, { para: 'a@b.test' }, { destinatario: 'a@b.test' }]) {
      assert.throws(() => S.acoes.enviarContato('sst', { assunto: 'a', mensagem: 'b', chaveIdempotencia: chave, ...extra }), TypeError);
      assert.throws(() => S.acoes.abrirChamado({ assunto: 'a', categoria: 'ERRO', descricao: 'b', chaveIdempotencia: chave, ...extra }), TypeError);
    }
    assert.throws(() => S.acoes.enviarContato('financeiro', { assunto: 'a', mensagem: 'b', chaveIdempotencia: chave }), TypeError);
    assert.throws(() => S.acoes.abrirChamado({ assunto: 'a', categoria: 'ERRO', descricao: 'b', chaveIdempotencia: 'x' }), TypeError);
    delete global.EpiHttp;
  });
});

describe('apresentação aprovada preservada', () => {
  test('cabeçalho, canais, textos e dúvidas frequentes da referência estão na página', () => {
    const html = lerArquivo(ARQUIVO);
    for (const texto of [
      'Central de ajuda para dúvidas do sistema, abertura de chamados e contatos de apoio.', 'Ajuda e atendimento', 'Canais de suporte',
      'Escolha o canal adequado conforme o tipo de necessidade.', 'Suporte do sistema', 'Abrir chamado', 'Almoxarifado / estoque', 'Solicitar apoio',
      'Dúvidas sobre saldo, entrega e reposição de materiais.', 'SST', 'Contatar SST', 'Tratativas sobre validade de uso, troca e exigência de EPI.',
      'Dúvidas frequentes', 'Respostas rápidas para os fluxos mais comuns do sistema.', 'Como solicitar um EPI?',
      'Acesse Pedido de EPI, selecione o item, tamanho e quantidade, depois envie a solicitação.', 'O que acontece se não tiver estoque?',
      'O pedido entra em Solicitações sem Estoque e aguarda compra ou reposição.', 'Onde vejo o histórico do colaborador?',
      'Na página Histórico de Funcionários, buscando por nome, matrícula ou CPF.',
    ]) assert.ok(html.includes(texto), `faltou "${texto}"`);
    assert.match(html, /<body class="reports-visual support-visual">/);
    assert.match(html, /<section id="supportView" class="view active">/);
    assert.match(html, /css\/support\.css/);
  });

  test('os três canais continuam na mesma ordem e na mesma estrutura (switch-row com botão mini-btn)', () => {
    const html = lerArquivo(ARQUIVO);
    const i = ['id="supAbrirChamado"', 'id="supContatarAlmoxarifado"', 'id="supContatarSst"'].map((t) => html.indexOf(t));
    assert.ok(i.every((x) => x > 0) && i[0] < i[1] && i[1] < i[2], 'ordem dos canais');
    assert.equal((html.match(/<button class="mini-btn" type="button" id="sup/g) ?? []).length, 3);
  });
});

describe('menu', () => {
  test('o item "Suporte" é o ativo desta página, sem etiqueta "Em integração", e a página usa a regra central (data-pagina support)', async () => {
    const pg = await pronta();
    const item = pg.consulta('.nav a[data-pagina="support"]')[0];
    assert.ok(item);
    assert.equal(item.classList.contains('active'), true);
    assert.equal(item.classList.contains('nav-pendente'), false);
    assert.equal(pg.visivel('conteudoProtegido'), true);
  });
});

describe('Suporte do sistema — Abrir chamado', () => {
  test('lista os próprios chamados do servidor; abre o formulário; valida localmente; envia UMA vez com chave e mostra o protocolo', async () => {
    const pg = await pronta({ itens: [chamado()] });
    assert.match(pg.texto('supChamados'), /SUP-2026-000011 · Erro ao salvar/);
    await pg.clicar('supAbrirChamado');
    assert.equal(pg.el('supChamadoModal').classList.contains('open'), true);

    await pg.clicar('supChamadoEnviar');
    assert.equal(postsDe(pg, '/suporte/chamados').length, 0, 'inválido não chega à rede');
    assert.match(pg.texto('err-supChamadoAssunto'), /Informe o assunto/);
    assert.match(pg.texto('err-supChamadoDescricao'), /Informe o texto/);

    await pg.digitar('supChamadoAssunto', '  Erro grave  ');
    pg.el('supChamadoCategoria').value = 'LENTIDAO';
    await pg.digitar('supChamadoDescricao', 'Muito lento ao salvar.');
    await pg.clicar('supChamadoEnviar');
    const posts = postsDe(pg, '/suporte/chamados');
    assert.equal(posts.length, 1);
    assert.deepEqual(Object.keys(posts[0].corpo).sort(), ['assunto', 'categoria', 'chaveIdempotencia', 'descricao']);
    assert.equal(posts[0].corpo.assunto, 'Erro grave');
    assert.match(posts[0].corpo.chaveIdempotencia, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.match(pg.texto('supAviso'), /Protocolo: SUP-2026-000099/);
    assert.equal(pg.el('supChamadoModal').classList.contains('open'), false);
    assert.match(pg.texto('supChamados'), /SUP-2026-000099/, 'a lista é relida do servidor');
  });

  test('falha de rede: mantém o formulário, a mesma chave no reenvio e o mesmo corpo (nunca duplica); depois do sucesso a chave muda', async () => {
    let falhar = true;
    const pg = await pronta({
      rotas: {
        'POST /suporte/chamados': () => (falhar ? new Error('rede') : { status: 201, corpo: { status: 'ok', chamado: chamado({ protocolo: 'SUP-2026-000050' }), repetido: false } }),
      },
    });
    await pg.clicar('supAbrirChamado');
    await pg.digitar('supChamadoAssunto', 'Assunto');
    pg.el('supChamadoCategoria').value = 'ERRO';
    await pg.digitar('supChamadoDescricao', 'Descrição');
    await pg.clicar('supChamadoEnviar');
    assert.equal(pg.el('supChamadoModal').classList.contains('open'), true);
    assert.match(pg.texto('supChamadoMsg'), /Não foi possível falar com o servidor/);
    falhar = false;
    await pg.clicar('supChamadoEnviar');
    const [a, b] = postsDe(pg, '/suporte/chamados');
    assert.equal(a.corpo.chaveIdempotencia, b.corpo.chaveIdempotencia);
    assert.deepEqual(a.corpo, b.corpo);
    assert.match(pg.texto('supAviso'), /SUP-2026-000050/);
  });

  test('XSS: assunto, descrição, resposta e protocolo do servidor entram só como texto; nenhum nó executável é criado', async () => {
    const carga = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const detalhe = {
      status: 'ok', chamado: chamado({ assunto: carga, descricao: carga }), mensagens: [{ id: 1, texto: carga, criadoEm: '2026-10-26T13:00:00.000Z', autor: 'SAFEWORK' }],
      historico: [{ id: 1, de: null, para: 'ABERTO', criadoEm: '2026-10-26T12:00:00.000Z' }],
    };
    const pg = await pronta({ itens: [chamado({ assunto: carga })], rotas: { 'GET /suporte/chamados/11': { status: 200, corpo: detalhe } } });
    assert.ok(pg.texto('supChamados').includes(carga), 'a lista mostra o texto literal');
    assert.equal(pg.consulta('#supChamados img, #supChamados script').length, 0);
    await pg.el('supChamados').querySelector('[data-chamado="11"]').disparar('click');
    await pg.esperar();
    for (const id of ['supDetAssunto', 'supDetDescricao', 'supConversa']) assert.ok(pg.texto(id).includes(carga), id);
    assert.equal(pg.consulta('#supDetalheModal img, #supDetalheModal script, #supChamados img').length, 0);
    assert.equal(pg.alertas.length, 0);
  });

  test('chamado de outro usuário (404 do servidor) não abre o detalhe e mostra aviso genérico', async () => {
    const pg = await pronta({
      itens: [chamado()],
      rotas: { 'GET /suporte/chamados/11': { status: 404, corpo: { status: 'error', codigo: 'CHAMADO_NAO_ENCONTRADO', message: 'Chamado não encontrado' } } },
    });
    await pg.el('supChamados').querySelector('[data-chamado="11"]').disparar('click');
    await pg.esperar();
    assert.equal(pg.el('supDetalheModal').classList.contains('open'), false);
    assert.match(pg.texto('supAviso'), /Não foi possível abrir o chamado/);
  });

  test('sessão encerrada (401) no envio leva ao estado de sessão encerrada, sem repetir', async () => {
    const pg = await pronta({ rotas: { 'POST /suporte/chamados': { status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO' } } } });
    await pg.clicar('supAbrirChamado');
    await pg.digitar('supChamadoAssunto', 'a');
    pg.el('supChamadoCategoria').value = 'ERRO';
    await pg.digitar('supChamadoDescricao', 'b');
    await pg.clicar('supChamadoEnviar');
    assert.equal(postsDe(pg, '/suporte/chamados').length, 1);
    assert.equal(pg.visivel('conteudoProtegido'), false);
  });
});

describe('Conversa do chamado (bate-papo vinculado ao protocolo)', () => {
  const msg = (id, autor, texto) => ({ id, autor, texto, criadoEm: `2026-10-26T12:0${id}:00.000Z` });
  function mundoConversa({ situacao = 'RESPONDIDO', mensagens = [msg(1, 'SAFEWORK', 'Olá, pode detalhar?')], naoLidas = 1 } = {}) {
    const estado = { situacao, mensagens: [...mensagens], posts: [], sondagens: 0 };
    const rotas = {
      'GET /suporte/chamados': () => ({ status: 200, corpo: { status: 'ok', itens: [chamado({ situacao: estado.situacao, naoLidas: estado.sondagens === 0 && estado.posts.length === 0 ? naoLidas : 0 })], total: 1, pagina: 1, limite: 20 } }),
      'GET /suporte/chamados/11': () => ({ status: 200, corpo: { status: 'ok', chamado: chamado({ situacao: estado.situacao }), mensagens: estado.mensagens, historico: [{ id: 1, de: null, para: 'ABERTO', criadoEm: '2026-10-26T12:00:00.000Z' }] } }),
      'GET /suporte/chamados/11/mensagens': (c) => {
        estado.sondagens += 1;
        const apos = Number(new URL(c.url).searchParams.get('aposId') || 0);
        return { status: 200, corpo: { status: 'ok', situacao: estado.situacao, encerradoEm: null, mensagens: estado.mensagens.filter((m) => m.id > apos) } };
      },
      'POST /suporte/chamados/11/mensagens': (c) => {
        estado.posts.push(c.corpo);
        if (estado.situacao === 'ENCERRADO') return { status: 409, corpo: { status: 'error', codigo: 'CHAMADO_ENCERRADO', message: 'x' } };
        const m = msg(estado.mensagens.length + 1, 'SOLICITANTE', c.corpo.texto);
        estado.mensagens.push(m);
        if (estado.situacao === 'RESPONDIDO' || estado.situacao === 'EM_ATENDIMENTO') estado.situacao = 'ABERTO';
        return { status: 201, corpo: { status: 'ok', mensagem: m, situacao: estado.situacao, repetido: false } };
      },
    };
    return { estado, rotas };
  }
  async function conversaAberta(opcoes) {
    const w = mundoConversa(opcoes);
    const pg = await pronta({ itens: [], rotas: w.rotas });
    await pg.el('supChamados').querySelector('[data-chamado="11"]').disparar('click');
    await pg.esperar();
    return Object.assign(pg, { estado: w.estado });
  }
  const bolhas = (pg) => pg.consulta('#supConversa [data-mensagem]').map((b) => [b.getAttribute('data-autor'), b.textContent]);

  test('a lista indica respostas não lidas (vindas do servidor) e o botão abre a conversa com remetente, horário, situação e campo de resposta', async () => {
    const pg = await conversaAberta();
    assert.match(pg.texto('supChamados'), /1 nova resposta/);
    assert.equal(pg.el('supDetalheModal').classList.contains('open'), true);
    assert.equal(bolhas(pg).length, 1);
    assert.equal(bolhas(pg)[0][0], 'SAFEWORK');
    assert.match(bolhas(pg)[0][1], /Suporte SafeWork · /);
    assert.match(bolhas(pg)[0][1], /pode detalhar/);
    assert.equal(pg.texto('supDetSituacao'), 'Respondido');
    assert.equal(pg.el('supConversaTexto').disabled, false);
    assert.equal(pg.temporizadoresPendentes().length, 1, 'uma sondagem agendada');
  });

  test('enviar mensagem: corpo só com texto e chave UUID, bolha "Você" acrescentada, situação volta a Aberto, chave nova para a próxima; mensagem vazia não vai à rede', async () => {
    const pg = await conversaAberta();
    await pg.clicar('supConversaEnviar');
    assert.equal(pg.estado.posts.length, 0);
    assert.match(pg.texto('err-supConversaTexto'), /Informe o texto/);
    await pg.digitar('supConversaTexto', '  Acontece ao salvar.  ');
    await pg.clicar('supConversaEnviar');
    assert.equal(pg.estado.posts.length, 1);
    assert.deepEqual(Object.keys(pg.estado.posts[0]).sort(), ['chaveIdempotencia', 'texto']);
    assert.equal(pg.estado.posts[0].texto, 'Acontece ao salvar.');
    assert.deepEqual(bolhas(pg).map((b) => b[0]), ['SAFEWORK', 'SOLICITANTE']);
    assert.match(bolhas(pg)[1][1], /Você · /);
    assert.equal(pg.el('supConversaTexto').value, '');
    assert.equal(pg.texto('supDetSituacao'), 'Aberto');
    assert.match(pg.texto('supConversaMsg'), /Mensagem enviada/);
    await pg.digitar('supConversaTexto', 'Outra');
    await pg.clicar('supConversaEnviar');
    assert.notEqual(pg.estado.posts[0].chaveIdempotencia, pg.estado.posts[1].chaveIdempotencia, 'chave nova depois do sucesso');
  });

  test('falha de rede no envio: o texto fica no campo e o reenvio usa a MESMA chave (sem duplicar)', async () => {
    let falhar = true;
    const w = mundoConversa();
    const original = w.rotas['POST /suporte/chamados/11/mensagens'];
    w.rotas['POST /suporte/chamados/11/mensagens'] = (c) => (falhar ? new Error('rede') : original(c));
    const pg = await pronta({ itens: [], rotas: w.rotas });
    await pg.el('supChamados').querySelector('[data-chamado="11"]').disparar('click');
    await pg.esperar();
    await pg.digitar('supConversaTexto', 'tentativa');
    await pg.clicar('supConversaEnviar');
    assert.equal(pg.el('supConversaTexto').value, 'tentativa', 'o texto não se perde');
    assert.match(pg.texto('supConversaMsg'), /Não foi possível falar com o servidor/);
    falhar = false;
    await pg.clicar('supConversaEnviar');
    const chamadas = pg.chamadas.filter((c) => c.chave === 'POST /suporte/chamados/11/mensagens');
    assert.equal(chamadas.length, 2);
    assert.equal(chamadas[0].corpo.chaveIdempotencia, chamadas[1].corpo.chaveIdempotencia);
  });

  test('sondagem: só com a conversa aberta, pede só o que é mais novo (aposId), acrescenta a resposta nova SEM tocar no texto digitado, e para quando a janela fecha', async () => {
    const pg = await conversaAberta();
    await pg.digitar('supConversaTexto', 'estou digitando');
    pg.estado.mensagens.push(msg(2, 'SAFEWORK', 'Nova resposta do suporte'));
    await pg.avancar(10000);
    const sondagens = pg.chamadas.filter((c) => c.chave === 'GET /suporte/chamados/11/mensagens');
    assert.equal(sondagens.length, 1);
    assert.match(sondagens[0].url, /aposId=1/);
    assert.deepEqual(bolhas(pg).map((b) => b[0]), ['SAFEWORK', 'SAFEWORK']);
    assert.equal(pg.el('supConversaTexto').value, 'estou digitando');
    assert.equal(pg.temporizadoresPendentes().length, 1, 'reagendada');
    await pg.avancar(10000);
    assert.match(pg.chamadas.filter((c) => c.chave === 'GET /suporte/chamados/11/mensagens').at(-1).url, /aposId=2/, 'a próxima parte da última recebida');
    const antes = pg.chamadas.length;
    await pg.el('supDetalheModal').querySelector('[data-fechar-modal]').disparar('click');
    await pg.esperar();
    assert.equal(pg.temporizadoresPendentes().length, 0, 'fechar para a sondagem');
    await pg.avancar(60000);
    assert.equal(pg.chamadas.filter((c) => c.chave === 'GET /suporte/chamados/11/mensagens').length, 2, 'nenhuma sondagem depois de fechar');
    assert.ok(pg.chamadas.slice(antes).some((c) => c.chave === 'GET /suporte/chamados'), 'a lista é relida ao fechar (não lidas vêm do servidor)');
  });

  test('sondagem com a requisição anterior ainda em voo não duplica; falha da sondagem avisa discretamente e continua', async () => {
    const w = mundoConversa();
    let segurar = null;
    const original = w.rotas['GET /suporte/chamados/11/mensagens'];
    w.rotas['GET /suporte/chamados/11/mensagens'] = (c) => (segurar ? segurar.then(() => original(c)) : new Error('rede'));
    const pg = await pronta({ itens: [], rotas: w.rotas });
    await pg.el('supChamados').querySelector('[data-chamado="11"]').disparar('click');
    await pg.esperar();
    await pg.avancar(10000);
    assert.match(pg.texto('supConversaMsg'), /Não foi possível buscar novas mensagens/);
    assert.equal(pg.temporizadoresPendentes().length, 1, 'continua tentando');
    let liberar;
    segurar = new Promise((r) => { liberar = r; });
    const promessa = pg.avancar(10000);
    await new Promise((r) => { setImmediate(r); });
    await pg.avancar(10000);
    liberar();
    await promessa;
    await pg.esperar();
    const sondagens = pg.chamadas.filter((c) => c.chave === 'GET /suporte/chamados/11/mensagens');
    assert.equal(sondagens.length, 2, 'uma falha + uma segurada; nenhuma em paralelo');
    assert.equal(pg.texto('supConversaMsg'), '', 'o aviso de falha some quando a sondagem volta a funcionar');
  });

  test('chamado encerrado: conversa legível, campo e botão desabilitados, orientação; encerramento que chega pela sondagem também trava', async () => {
    const pg = await conversaAberta({ situacao: 'ENCERRADO' });
    assert.equal(pg.el('supConversaTexto').disabled, true);
    assert.equal(pg.el('supConversaEnviar').disabled, true);
    assert.match(pg.texto('supConversaMsg'), /encerrado/);
    assert.equal(pg.temporizadoresPendentes().length, 0, 'sem sondagem num chamado encerrado');
    const aberta = await conversaAberta({ situacao: 'ABERTO' });
    aberta.estado.situacao = 'ENCERRADO';
    await aberta.avancar(10000);
    assert.equal(aberta.el('supConversaTexto').disabled, true);
    assert.match(aberta.texto('supConversaMsg'), /O suporte encerrou este chamado/);
  });

  test('409 CHAMADO_ENCERRADO ao enviar (encerrado por fora): a tela passa a encerrada, sem erro genérico', async () => {
    const pg = await conversaAberta({ situacao: 'ABERTO' });
    await pg.digitar('supConversaTexto', 'tarde');
    pg.estado.situacao = 'ENCERRADO';
    await pg.clicar('supConversaEnviar');
    assert.equal(pg.el('supConversaTexto').disabled, true);
    assert.equal(pg.texto('supDetSituacao'), 'Encerrado');
  });

  test('XSS na conversa: mensagem do servidor entra só como texto; nenhum nó executável', async () => {
    const carga = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const pg = await conversaAberta({ mensagens: [msg(1, 'SAFEWORK', carga)] });
    assert.ok(pg.texto('supConversa').includes(carga));
    assert.equal(pg.consulta('#supConversa img, #supConversa script').length, 0);
  });
});

describe('Almoxarifado e SST', () => {
  const contato = (situacaoEnvio, extra = {}) => ({
    status: 201, corpo: { status: 'ok', repetido: false, contato: { id: 5, canal: 'ALMOXARIFADO', situacaoEnvio, entregaConfirmada: situacaoEnvio === 'ENVIO_CONFIRMADO', ...extra } },
  });

  test('mostra só se o e-mail está cadastrado (nunca o endereço) e envia assunto, mensagem e chave — sem destinatário no corpo', async () => {
    const pg = await pronta({ rotas: { 'POST /suporte/contatos/almoxarifado': contato('ENVIO_CONFIRMADO') } });
    assert.match(pg.texto('supEstadoAlmoxarifado'), /E-mail cadastrado em Dados da Empresa/);
    assert.match(pg.texto('supEstadoSst'), /ainda não cadastrado/);
    await pg.clicar('supContatarAlmoxarifado');
    await pg.digitar('supContatoAssunto', 'Falta de luva');
    await pg.digitar('supContatoMensagem', 'Precisamos repor.');
    await pg.clicar('supContatoEnviar');
    const [post] = postsDe(pg, '/suporte/contatos/almoxarifado');
    assert.deepEqual(Object.keys(post.corpo).sort(), ['assunto', 'chaveIdempotencia', 'mensagem']);
    assert.match(pg.texto('supAviso'), /registrada e enviada ao e-mail cadastrado do Almoxarifado/);
    assert.equal(/example\.invalid|@/.test(pg.texto('supEstadoAlmoxarifado')), false);
  });

  test('SST sem e-mail cadastrado: orientação clara já ao abrir; o servidor recusa (409) e a tela mostra a orientação, sem sucesso', async () => {
    const pg = await pronta({
      rotas: { 'POST /suporte/contatos/sst': { status: 409, corpo: { status: 'error', codigo: 'DESTINATARIO_NAO_CONFIGURADO', message: 'x' } } },
    });
    await pg.clicar('supContatarSst');
    assert.match(pg.texto('supContatoMsg'), /O e-mail da SST ainda não foi cadastrado/);
    assert.match(pg.texto('supContatoMsg'), /Dados da Empresa/);
    await pg.digitar('supContatoAssunto', 'a');
    await pg.digitar('supContatoMensagem', 'b');
    await pg.clicar('supContatoEnviar');
    assert.match(pg.texto('supContatoMsg'), /O e-mail da SST ainda não foi cadastrado/);
    assert.equal(pg.texto('supAviso'), '', 'nenhum aviso de sucesso');
    assert.equal(pg.el('supContatoModal').classList.contains('open'), true);
  });

  test('nunca apresenta sucesso de entrega sem confirmação: arquivo, provedor ausente e falha dizem exatamente o que aconteceu', async () => {
    for (const [situacao, esperado, proibido] of [
      ['GRAVADO_EM_ARQUIVO', /Nenhum e-mail foi entregue/, /enviada ao e-mail/],
      ['NAO_ENVIADO', /Nenhum e-mail foi entregue/, /enviada ao e-mail/],
      ['FALHA', /o envio por e-mail falhou\. Nenhum e-mail foi entregue/, /enviada ao e-mail/],
      ['REGISTRADA', /ainda não foi confirmado/, /enviada ao e-mail/],
    ]) {
      const pg = await pronta({ rotas: { 'POST /suporte/contatos/almoxarifado': contato(situacao) } });
      await pg.clicar('supContatarAlmoxarifado');
      await pg.digitar('supContatoAssunto', 'a');
      await pg.digitar('supContatoMensagem', 'b');
      await pg.clicar('supContatoEnviar');
      assert.match(pg.texto('supAviso'), esperado, situacao);
      assert.doesNotMatch(pg.texto('supAviso'), proibido, situacao);
    }
  });

  test('clique duplo não envia duas vezes e a chave é a mesma na nova tentativa após falha de rede', async () => {
    let n = 0;
    const pg = await pronta({
      rotas: { 'POST /suporte/contatos/almoxarifado': () => { n += 1; return n === 1 ? new Error('rede') : contato('ENVIO_CONFIRMADO'); } },
    });
    await pg.clicar('supContatarAlmoxarifado');
    await pg.digitar('supContatoAssunto', 'a');
    await pg.digitar('supContatoMensagem', 'b');
    await pg.clicar('supContatoEnviar');
    await pg.clicar('supContatoEnviar');
    const posts = postsDe(pg, '/suporte/contatos/almoxarifado');
    assert.equal(posts.length, 2);
    assert.equal(posts[0].corpo.chaveIdempotencia, posts[1].corpo.chaveIdempotencia);
  });

  test('429 mostra o aviso de limite sem perder o texto digitado', async () => {
    const pg = await pronta({ rotas: { 'POST /suporte/contatos/almoxarifado': { status: 429, corpo: { status: 'error', codigo: 'LIMITE_EXCEDIDO' } } } });
    await pg.clicar('supContatarAlmoxarifado');
    await pg.digitar('supContatoAssunto', 'a');
    await pg.digitar('supContatoMensagem', 'texto preservado');
    await pg.clicar('supContatoEnviar');
    assert.match(pg.texto('supContatoMsg'), /Muitas tentativas/);
    assert.equal(pg.el('supContatoMensagem').value, 'texto preservado');
  });
});
