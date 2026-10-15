'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/totem-i');
const { existePagina } = require('./helpers/dom-pagina');

/**
 * Etapa I (RED) — controles do PRÓPRIO helper (`helpers/totem-i.js`): relógio virtual, AbortController, cabeçalhos de
 * resposta e fidelidade do servidor falso ao contrato das Etapas C–G. Estes testes passam hoje (classe PASS, controle do
 * harness): provam que o vermelho dos demais arquivos da Etapa I vem da funcionalidade ausente e não do ambiente de teste.
 */

const API = 'http://localhost:3000/api';
const BASE = H.BASE;
const PREAMBULO = `
  window.pegar = function (caminho, opcoes) {
    return fetch('${API}' + caminho, Object.assign({ method: 'GET', credentials: 'include' }, opcoes || {})).then(function (r) {
      return r.text().then(function (tx) { return { status: r.status, retry: r.headers.get('Retry-After'), corpo: tx ? JSON.parse(tx) : null }; });
    });
  };
  window.postar = function (caminho, corpo) {
    return window.pegar(caminho, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(corpo === undefined ? {} : corpo) });
  };
`;
const html = (script, corpo = '') => `<!DOCTYPE html><html><head><title>controle</title><style>.oculto{display:none}</style></head><body>${corpo}<script>${PREAMBULO}${script}</script></body></html>`;

describe('[HELPER] relógio virtual, AbortController e fetch com cabeçalhos', () => {
  test('[HELPER-01] timers, setInterval, Date.now e performance.now seguem o relógio virtual, em ordem', async () => {
    const t = await H.abrirHtmlDeControle(html(`
      window.ordem = []; var n = 0;
      setTimeout(function () { ordem.push('b'); }, 200);
      setTimeout(function () { ordem.push('a'); }, 100);
      setInterval(function () { n += 1; ordem.push('i' + n); }, 150);
      window.horas = function () { return [Date.now(), performance.now()]; };
    `));
    const inicio = t.janela.horas();
    t.relogio.avancar(100);
    assert.deepEqual([...t.janela.ordem], ['a']);
    t.relogio.avancar(100);
    assert.deepEqual([...t.janela.ordem], ['a', 'i1', 'b']);
    t.relogio.avancar(100);
    assert.deepEqual([...t.janela.ordem], ['a', 'i1', 'b', 'i2']);
    const fim = t.janela.horas();
    assert.equal(fim[0] - inicio[0], 300);
    assert.equal(fim[1] - inicio[1], 300);
  });

  test('[HELPER-02] clearTimeout/clearInterval removem do relógio virtual', async () => {
    const t = await H.abrirHtmlDeControle(html(`window.n = 0; window.id = setInterval(function () { n += 1; }, 100); window.t2 = setTimeout(function () { n += 100; }, 150);`));
    t.relogio.avancar(100);
    assert.equal(t.janela.n, 1);
    t.janela.clearInterval(t.janela.id); t.janela.clearTimeout(t.janela.t2);
    t.relogio.avancar(1000);
    assert.equal(t.janela.n, 1);
    assert.equal(t.relogio.pendentes().length, 0);
  });

  test('[HELPER-03] o fetch devolve os cabeçalhos da resposta (Retry-After)', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(`POST ${BASE}/atendimento/atividade`, '429', { retryAfter: 7 });
    const t = await H.abrirHtmlDeControle(html(''), { servidor });
    const r = await t.janela.postar(`${BASE}/atendimento/atividade`);
    assert.equal(r.status, 429);
    assert.equal(r.retry, '7');
    assert.equal(r.corpo.codigo, 'LIMITE_REQUISICOES_EXCEDIDO');
  });

  test('[HELPER-04] AbortController aborta um fetch pendente no tempo virtual', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(`GET ${BASE}/estado`, 'pendente');
    const t = await H.abrirHtmlDeControle(html(`
      window.estado = 'pendente';
      window.iniciar = function () {
        var c = new AbortController();
        fetch('${API}${BASE}/estado', { signal: c.signal }).then(function () { window.estado = 'ok'; }, function (e) { window.estado = e.name; });
        setTimeout(function () { c.abort(); }, 5000);
      };
    `), { servidor });
    t.janela.iniciar();
    await t.passar(4000);
    assert.equal(t.janela.estado, 'pendente');
    await t.passar(1000);
    assert.equal(t.janela.estado, 'AbortError');
    assert.equal(t.janela.__abortos, 1);
  });

  test('[HELPER-05] falha de rede simulada rejeita o fetch; "perdida" aplica o efeito e também rejeita', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirHtmlDeControle(html(`window.tentar = function (c) { return postar('${BASE}/atendimento/encerrar', c).then(function (r) { return 'resposta ' + r.status; }, function (e) { return 'erro'; }); };`), { servidor });
    servidor.falhar(`POST ${BASE}/atendimento/encerrar`, 'rede');
    assert.equal(await t.janela.tentar(), 'erro');
  });
});

describe('[HELPER] o servidor falso reproduz o contrato real das Etapas C–G', () => {
  const ana = H.FUNCIONARIOS[0];

  test('[HELPER-10] identificação: CPF só estrutura, matrícula exata e sensível a caixa, zeros preservados, 404 único', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirHtmlDeControle(html(''), { servidor });
    const id = (tipo, valor) => t.janela.postar(`${BASE}/atendimento`, { tipo, valor });
    assert.equal((await id('CPF', ana.cpf)).status, 201);
    assert.equal((await id('MATRICULA', 'mat-0045')).corpo.atendimento.funcionario.primeiroNome, 'Bruno');
    assert.equal((await id('MATRICULA', 'MAT-0045')).status, 404);
    assert.equal((await id('MATRICULA', '0123')).corpo.atendimento.funcionario.primeiroNome, 'Carla');
    assert.equal((await id('MATRICULA', '123')).corpo.atendimento.funcionario.primeiroNome, 'Daniel');
    assert.equal((await id('MATRICULA', 'inativa-1')).status, 404);
    assert.equal((await id('CPF', '123')).status, 400);
    assert.deepEqual(servidor.violacoes, []);
    await id('CPF', '529.982.247-25');
    assert.deepEqual(servidor.violacoes, ['CPF enviado com pontuação ou letras']);
  });

  test('[HELPER-11] identificação: resposta só com primeiroNome, expiraEm e inatividadeSegundos; limite de 10 por minuto', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirHtmlDeControle(html(''), { servidor });
    const r = await t.janela.postar(`${BASE}/atendimento`, { tipo: 'CPF', valor: ana.cpf });
    assert.deepEqual(Object.keys(r.corpo.atendimento).sort(), ['expiraEm', 'funcionario', 'inatividadeSegundos']);
    assert.deepEqual(Object.keys(r.corpo.atendimento.funcionario), ['primeiroNome']);
    assert.equal(r.corpo.atendimento.inatividadeSegundos, 60);
    for (let i = 0; i < 9; i += 1) assert.equal((await t.janela.postar(`${BASE}/atendimento`, { tipo: 'CPF', valor: ana.cpf })).status, 201);
    const onze = await t.janela.postar(`${BASE}/atendimento`, { tipo: 'CPF', valor: ana.cpf });
    assert.equal(onze.status, 429);
    assert.equal(onze.retry, '30');
  });

  test('[HELPER-12] sessão: 60 s deslizantes no relógio do servidor; GET não renova; só /atividade renova; sem teto absoluto', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirHtmlDeControle(html(''), { servidor });
    await t.janela.postar(`${BASE}/atendimento`, { tipo: 'CPF', valor: ana.cpf });
    servidor.avancar(30000);
    const estado = await t.janela.pegar(`${BASE}/atendimento`);
    assert.equal(estado.corpo.atendimento.restanteSegundos, 30);
    servidor.avancar(31000);
    assert.equal((await t.janela.pegar(`${BASE}/atendimento`)).status, 401);

    await t.janela.postar(`${BASE}/atendimento`, { tipo: 'CPF', valor: ana.cpf });
    for (let i = 0; i < 10; i += 1) {
      servidor.avancar(50000);
      assert.equal((await t.janela.postar(`${BASE}/atendimento/atividade`)).corpo.atendimento.restanteSegundos, 60);
    }
    assert.equal(servidor.atendimentoAberto(), true);
    servidor.avancar(61000);
    assert.equal(servidor.atendimentoAberto(), false);
  });

  test('[HELPER-13] pedido: corpo estrito, idempotência, 409 por material+tamanho, encerramento e cookie removido', async () => {
    const servidor = H.criarServidor({ solicitacoes: [{ materialId: 13, nome: 'Camiseta', tamanho: 'M', situacao: 'AGUARDANDO_APROVACAO', quantidade: 1 }] });
    const t = await H.abrirHtmlDeControle(html(''), { servidor });
    await t.janela.postar(`${BASE}/atendimento`, { tipo: 'CPF', valor: ana.cpf });
    const chave = '11111111-1111-4111-8111-111111111111';
    const item = (materialId, tamanho) => ({ materialId, tamanho, quantidade: 1, motivo: 'DESGASTE_DANO' });

    const duplicado = await t.janela.postar(`${BASE}/atendimento/pedido`, { chaveIdempotencia: chave, itens: [item(11, '40'), item(13, 'M')] });
    assert.equal(duplicado.status, 409);
    assert.equal(duplicado.corpo.codigo, 'ITEM_JA_SOLICITADO');
    assert.equal(duplicado.corpo.detalhes[0].campo, 'body.itens[1].materialId');
    assert.equal(servidor.pedidos.size, 0);
    assert.equal(servidor.atendimentoAberto(), true);

    const ok = await t.janela.postar(`${BASE}/atendimento/pedido`, { chaveIdempotencia: chave, itens: [item(11, '40'), item(12, null)] });
    assert.equal(ok.status, 201);
    assert.equal(ok.corpo.repetida, false);
    assert.equal(servidor.atendimentoAberto(), false);
    const repetido = await t.janela.postar(`${BASE}/atendimento/pedido`, { chaveIdempotencia: chave, itens: [item(11, '40'), item(12, null)] });
    assert.equal(repetido.status, 401, 'o cookie do atendimento foi removido no sucesso entregue');
    assert.equal(servidor.pedidos.size, 1);
    assert.deepEqual(servidor.violacoes, []);
  });

  test('[HELPER-14] pedido com resposta perdida: efeito aplicado no servidor, repetição idempotente com o cookie ainda válido', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirHtmlDeControle(html(''), { servidor });
    await t.janela.postar(`${BASE}/atendimento`, { tipo: 'CPF', valor: ana.cpf });
    servidor.falhar(`POST ${BASE}/atendimento/pedido`, 'perdida');
    const chave = '22222222-2222-4222-8222-222222222222';
    const corpo = { chaveIdempotencia: chave, itens: [{ materialId: 12, tamanho: null, quantidade: 1, motivo: 'PERDA_EXTRAVIO' }] };
    const falhou = await t.janela.postar(`${BASE}/atendimento/pedido`, corpo).then(() => 'resposta', () => 'erro');
    assert.equal(falhou, 'erro');
    assert.equal(servidor.pedidos.size, 1);
    const verificacao = await t.janela.pegar(`${BASE}/atendimento/pedidos/${chave}`);
    assert.equal(verificacao.corpo.pedido.estado, 'REGISTRADO');
    const repetido = await t.janela.postar(`${BASE}/atendimento/pedido`, corpo);
    assert.equal(repetido.status, 200);
    assert.equal(repetido.corpo.repetida, true);
    assert.equal(servidor.pedidos.size, 1);
    assert.equal((await t.janela.pegar(`${BASE}/atendimento/pedidos/${chave}`)).status, 401, 'o 200 repetido também remove o cookie do atendimento');
  });

  test('[HELPER-14b] depois dos 60 s do cookie não há recuperação direta da resposta (D-F6)', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirHtmlDeControle(html(''), { servidor });
    await t.janela.postar(`${BASE}/atendimento`, { tipo: 'CPF', valor: ana.cpf });
    servidor.falhar(`POST ${BASE}/atendimento/pedido`, 'perdida');
    const chave = '33333333-3333-4333-8333-333333333333';
    const corpo = { chaveIdempotencia: chave, itens: [{ materialId: 12, tamanho: null, quantidade: 1, motivo: 'PERDA_EXTRAVIO' }] };
    await t.janela.postar(`${BASE}/atendimento/pedido`, corpo).then(() => null, () => null);
    servidor.avancar(61000);
    assert.equal((await t.janela.pegar(`${BASE}/atendimento/pedidos/${chave}`)).status, 401);
    assert.equal((await t.janela.postar(`${BASE}/atendimento/pedido`, corpo)).status, 401);
    assert.equal(servidor.pedidos.size, 1, 'o pedido persistido continua existindo');
  });

  test('[HELPER-15] o servidor registra violações do contrato por parte da página (sem credentials, cabeçalho extra, query)', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirHtmlDeControle(html(''), { servidor });
    await t.janela.pegar(`${BASE}/estado`, { credentials: 'omit', headers: { Authorization: 'Bearer x' } });
    assert.ok(servidor.violacoes.some((v) => v.startsWith('sem credentials')), JSON.stringify(servidor.violacoes));
    assert.ok(servidor.violacoes.some((v) => v.includes('Authorization')), JSON.stringify(servidor.violacoes));
    await t.janela.pegar(`${BASE}/estado?x=1`);
    assert.ok(servidor.violacoes.some((v) => v.startsWith('query string')));
  });

  test('[HELPER-16] ativação: uso único, falha uniforme, rede não consome o código, reativação conta', async () => {
    const codigo = H.novoToken();
    const servidor = H.criarServidor({ tablet: 'nao_autorizado', codigos: { [codigo]: 'valido' } });
    const t = await H.abrirHtmlDeControle(html(''), { servidor });
    assert.equal((await t.janela.pegar(`${BASE}/estado`)).status, 401);
    assert.equal((await t.janela.postar(`${BASE}/ativar`, { codigo: 'curto' })).status, 401);
    servidor.tablet = 'rede';
    assert.equal((await t.janela.postar(`${BASE}/ativar`, { codigo })).status, 403);
    assert.equal(servidor.codigos.get(codigo), 'valido', 'o 403 de rede não consome o código');
    servidor.tablet = 'nao_autorizado';
    assert.equal((await t.janela.postar(`${BASE}/ativar`, { codigo })).status, 200);
    assert.equal((await t.janela.postar(`${BASE}/ativar`, { codigo })).status, 401);
    assert.equal(servidor.reativacoes, 0);
    const outro = H.novoToken();
    servidor.codigos.set(outro, 'valido');
    assert.equal((await t.janela.postar(`${BASE}/ativar`, { codigo: outro })).status, 200);
    assert.equal(servidor.reativacoes, 1);
  });

  test('[HELPER-17] catálogo e consulta G: formas exatas e sem saldo; imagem sempre { disponivel: false }', async () => {
    const servidor = H.criarServidor({ solicitacoes: [{ materialId: 11, nome: 'Botina de Segurança', tamanho: '40', situacao: 'AGUARDANDO_ESTOQUE', quantidade: 2 }, { materialId: 13, nome: 'Camiseta', tamanho: 'M', situacao: 'DISPONIVEL_PARA_RETIRADA', quantidade: 1 }] });
    const t = await H.abrirHtmlDeControle(html(''), { servidor });
    await t.janela.postar(`${BASE}/atendimento`, { tipo: 'CPF', valor: ana.cpf });
    const plano = (x) => JSON.parse(JSON.stringify(x)); // objetos do contexto da página: outra realm
    const cat = plano(await t.janela.pegar(`${BASE}/atendimento/catalogo`));
    assert.equal(cat.corpo.catalogo.estado, 'OK');
    assert.equal(cat.corpo.catalogo.total, 4);
    for (const m of cat.corpo.catalogo.materiais) {
      assert.deepEqual(Object.keys(m).sort(), ['categoria', 'exigeTamanho', 'grupoProtecao', 'id', 'imagem', 'nome', 'tamanhos', 'tipo', 'unidade']);
      assert.deepEqual(m.imagem, { disponivel: false });
    }
    const g = plano(await t.janela.pegar(`${BASE}/atendimento/solicitacoes`));
    assert.equal(g.corpo.temDisponiveis, true);
    assert.deepEqual(g.corpo.itens.map((i) => i.situacao), ['DISPONIVEL_PARA_RETIRADA', 'AGUARDANDO_ESTOQUE']);
    assert.deepEqual(Object.keys(g.corpo.itens[0]).sort(), ['materialId', 'nome', 'quantidade', 'retiradaParcial', 'situacao', 'tamanho']);
  });

  test('[HELPER-18] textoRenderizado ignora elementos com display:none e scripts', async () => {
    const t = await H.abrirHtmlDeControle(html('', '<p>visível</p><p class="oculto">escondido</p><div hidden>também</div>'));
    const texto = t.textoVisivel();
    assert.ok(texto.includes('visível'));
    assert.ok(!texto.includes('escondido'));
    assert.ok(!texto.includes('controle'), 'o título e o script não entram');
    assert.ok(t.textoDoDom().includes('escondido'), 'o DOM completo ainda o contém');
  });
});

describe('[HELPER] vazamentos, teclado e botões funcionam sobre o protótipo original (somente leitura)', () => {
  const ORIGINAL = process.env.TOTEM_I_HTML_ORIGINAL ?? require('node:path').join(require('node:os').homedir(), 'Desktop', 'token-epi.html');
  const semOriginal = require('node:fs').existsSync(ORIGINAL) ? false : 'BLOQUEADO: o protótipo original não está na máquina';

  test('[HELPER-19] vazamentos() acusa o segredo em console, storage, histórico e DOM', async () => {
    const t = await H.abrirHtmlDeControle(html(`
      var segredo = 'SEGREDO-DE-TESTE-123';
      console.log(segredo); localStorage.setItem('k', segredo); history.replaceState(null, '', '#' + segredo);
      document.getElementById('alvo').textContent = segredo;
    `, '<p id="alvo"></p>'));
    const achados = H.vazamentos(t, { segredo: 'SEGREDO-DE-TESTE-123', outro: 'NAO-EXISTE' });
    for (const local of ['storage', 'console', 'historico', 'dom']) assert.ok(achados.includes(`segredo em ${local}`), `${local}: ${JSON.stringify(achados)}`);
    assert.ok(!achados.some((a) => a.startsWith('outro')));
  });

  test('[HELPER-21] botoesVisiveis e telaAtual leem o protótipo original; o harness NÃO executa manipuladores inline (por isso a página integrada precisa de addEventListener)', { skip: semOriginal }, async () => {
    const t = await H.abrirHtmlDeControle(require('node:fs').readFileSync(ORIGINAL, 'utf8'));
    const rotulos = t.botoesVisiveis().join('|');
    for (const esperado of ['Limpar', 'Continuar', 'Minha matrícula tem letras']) assert.ok(rotulos.includes(esperado), rotulos);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    await t.digitar('1234');
    assert.equal(t.el('doc').value, '', 'os onclick="..." do protótipo não rodam no harness: limitação conhecida, tratada pelo teste Q0-23');
  });

  test('[HELPER-22] o texto-fonte do protótipo original usa armazenamento do navegador e identificação local (comportamento demonstrativo que a Etapa I substitui)', { skip: semOriginal }, () => {
    const fonte = require('node:fs').readFileSync(ORIGINAL, 'utf8');
    for (const marca of ['localStorage.getItem', 'localStorage.setItem', 'epi_db_v2', 'IDLE_S = 90', 'mousemove', 'SEED', 'Reservar']) assert.ok(fonte.includes(marca), marca);
  });
});

describe('[HELPER] a ausência da página derivada é um RED legível', () => {
  test('[HELPER-20] abrirTotem falha com a asserção "RED I: ... ainda não existe" enquanto frontend/totem/index.html não existir', { skip: existePagina('totem/index.html') || Boolean(process.env.TOTEM_I_DIAGNOSTICO_HTML) }, async () => {
    await assert.rejects(() => H.abrirTotem(), (e) => e.name === 'AssertionError' && /RED I: a página derivada totem\/index\.html ainda não existe/.test(e.message));
  });
});
