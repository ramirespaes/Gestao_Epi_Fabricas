'use strict';

const crypto = require('node:crypto');
const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Router } = require('express');

const { montar } = require('./helpers/gestao-usuarios-app');
const { criarSessaoAdministrativa } = require('./helpers/sessao-plataforma-teste');
const { criarSuporteRoutes } = require('../../src/routes/suporte.routes');
const { criarSuporteController } = require('../../src/controllers/suporte.controller');
const { criarSuportePlataformaRoutes } = require('../../src/routes/suporte-plataforma.routes');
const { criarSuportePlataformaController } = require('../../src/controllers/suporte-plataforma.controller');
const { criarExigirSessaoPlataforma } = require('../../src/middleware/autenticacao-plataforma');
const { criarInicial } = require('../../src/services/administrador-plataforma.service');

/**
 * Suporte (migration 092) — HTTP real contra PostgreSQL real (schema temporário, todas as migrations): chamados do Portal,
 * contatos com o Almoxarifado e a SST (transporte de e-mail SIMULADO: nenhuma mensagem real), atendimento no Painel Privado,
 * isolamento por empresa e usuário, idempotência, concorrência, auditoria e proteção contra XSS.
 */
const PORTAL = '/api/suporte';
const PAINEL = '/api/plataforma/suporte';
const uuid = () => crypto.randomUUID();

describe('Suporte — Portal + Painel Privado (PostgreSQL real)', () => {
  let g;
  let a1; // empresa A, usuário 1
  let a2; // empresa A, usuário 2
  let b1; // empresa B
  let cookieAdmin;
  let modo = 'ENVIADO';
  const envios = [];
  const servicoEmail = {
    async enviarAguardando(mensagem) {
      envios.push(mensagem);
      if (modo === 'FALHA') return { estado: 'FALHA', codigo: 'ETIMEDOUT' };
      return { estado: modo };
    },
  };

  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => {
      const exigirSessaoPlataforma = criarExigirSessaoPlataforma({ pool });
      const portal = criarSuporteRoutes({
        controller: criarSuporteController({ pool, servicoEmail }),
        exigirSessao: exigirEmpresarial,
        limites: {
          chamadoPorUsuario: 100000, chamadoPorEmpresa: 100000, contatoPorUsuario: 100000, contatoPorEmpresa: 100000, mensagemPorUsuario: 100000, mensagemPorEmpresa: 100000,
        },
      });
      const painel = Router().use('/plataforma', criarSuportePlataformaRoutes({
        controller: criarSuportePlataformaController({ pool }), exigirSessaoPlataforma, limiteEscritaPorMinuto: 100000,
      }));
      return [portal, painel];
    } });
    a1 = await g.contaDaEmpresa(g.empresas.A, 'MASTER');
    a2 = await g.contaDaEmpresa(g.empresas.A, 'USUARIO');
    b1 = await g.contaDaEmpresa(g.empresas.B, 'MASTER');
    const admin = await criarInicial(g.pool, { email: 'admin.suporte@safework.com.br', senha: 'planeta-nebulosa-ozonio-42' });
    ({ cookie: cookieAdmin } = await criarSessaoAdministrativa(g.pool, admin.id));
    await g.pool.query('UPDATE empresas SET email_almoxarifado = $2, email_sst = $3 WHERE id = $1', [g.empresas.A, 'almox.a@example.invalid', 'sst.a@example.invalid']);
    await g.pool.query('UPDATE empresas SET email_almoxarifado = $2, email_sst = NULL WHERE id = $1', [g.empresas.B, 'almox.b@example.invalid']);
  });
  after(async () => { if (g) await g.encerrar(); });

  const como = (c, metodo, caminho, corpo) => {
    const r = g.request(g.app)[metodo](caminho).set('Cookie', g.cookie(c));
    return corpo === undefined ? r : r.send(corpo);
  };
  const painel = (metodo, caminho, corpo) => {
    const r = g.request(g.app)[metodo](caminho).set('Cookie', cookieAdmin);
    return corpo === undefined ? r : r.send(corpo);
  };
  const chamadoValido = (extra = {}) => ({ assunto: 'Erro ao salvar', categoria: 'ERRO', descricao: 'A tela trava ao salvar.', chaveIdempotencia: uuid(), ...extra });
  const contatoValido = (extra = {}) => ({ assunto: 'Falta de luva', mensagem: 'Precisamos repor luvas P.', chaveIdempotencia: uuid(), ...extra });
  const abrir = async (c, extra) => {
    const r = await como(c, 'post', `${PORTAL}/chamados`, chamadoValido(extra));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.chamado;
  };

  test('401: nenhuma rota do Portal responde sem sessão e o cookie da plataforma não as autentica', async () => {
    for (const [metodo, caminho] of [['get', '/canais'], ['get', '/chamados'], ['post', '/chamados'], ['get', '/chamados/1'], ['post', '/contatos/sst']]) {
      assert.equal((await g.request(g.app)[metodo](`${PORTAL}${caminho}`).send({})).status, 401, `${metodo} ${caminho}`);
      assert.equal((await g.request(g.app)[metodo](`${PORTAL}${caminho}`).set('Cookie', cookieAdmin).send({})).status, 401, `plataforma ${caminho}`);
    }
  });

  test('401: nenhuma rota do Painel responde sem sessão administrativa; a sessão empresarial (MASTER inclusive) não as alcança', async () => {
    for (const [metodo, caminho] of [['get', '/chamados'], ['get', '/chamados/1'], ['post', '/chamados/1/respostas'], ['patch', '/chamados/1/situacao']]) {
      assert.equal((await g.request(g.app)[metodo](`${PAINEL}${caminho}`).send({})).status, 401, `${metodo} ${caminho}`);
      assert.equal((await como(a1, metodo, `${PAINEL}${caminho}`, {})).status, 401, `empresarial ${caminho}`);
    }
  });

  test('abrir chamado: 201 com protocolo único; empresa, usuário e e-mail vêm da sessão e o corpo não pode trazê-los', async () => {
    const c = await abrir(a1);
    assert.match(c.protocolo, /^SUP-\d{4}-\d{6}$/);
    assert.equal(c.situacao, 'ABERTO');
    const linha = await g.um('SELECT * FROM suporte_chamados WHERE id = $1', [c.id]);
    assert.deepEqual([linha.empresa_id, linha.usuario_id], [g.empresas.A, a1.usuarioId]);
    assert.equal(linha.solicitante_email.length > 0, true);
    const outro = await abrir(a1);
    assert.notEqual(outro.protocolo, c.protocolo);
    for (const proibido of [{ empresaId: g.empresas.B }, { usuarioId: 1 }, { email: 'x@y.test' }, { situacao: 'ENCERRADO' }, { protocolo: 'SUP-0000-000000' }, { destinatario: 'x@y.test' }]) {
      const r = await como(a1, 'post', `${PORTAL}/chamados`, chamadoValido(proibido));
      assert.equal(r.status, 400, JSON.stringify(proibido));
    }
  });

  test('validação: assunto vazio, categoria inválida, descrição vazia ou acima de 4000, chave que não é UUID e controle no texto', async () => {
    const ruins = [
      { assunto: '   ' }, { assunto: 'x'.repeat(151) }, { categoria: 'HACK' }, { descricao: '  ' }, { descricao: 'a'.repeat(4001) },
      { chaveIdempotencia: 'abc' }, { descricao: 'texto\u0000nulo' }, { assunto: 'linha\nquebrada' },
    ];
    for (const r of ruins) assert.equal((await como(a1, 'post', `${PORTAL}/chamados`, chamadoValido(r))).status, 400, JSON.stringify(r).slice(0, 40));
    assert.equal((await como(a1, 'post', `${PORTAL}/chamados`, chamadoValido({ descricao: 'a'.repeat(4000) }))).status, 201);
    assert.equal((await como(a1, 'post', `${PORTAL}/chamados`, chamadoValido({ descricao: 'linha 1\r\nlinha 2' }))).status, 201);
  });

  test('idempotência: o mesmo pedido devolve o mesmo chamado sem duplicar; a mesma chave com outro conteúdo é 409', async () => {
    const corpo = chamadoValido();
    const r1 = await como(a1, 'post', `${PORTAL}/chamados`, corpo);
    const r2 = await como(a1, 'post', `${PORTAL}/chamados`, corpo);
    assert.deepEqual([r1.status, r2.status, r2.body.repetido], [201, 200, true]);
    assert.equal(r1.body.chamado.protocolo, r2.body.chamado.protocolo);
    assert.equal((await g.um('SELECT count(*)::int AS n FROM suporte_chamados WHERE chave_idempotencia = $1', [corpo.chaveIdempotencia])).n, 1);
    const r3 = await como(a1, 'post', `${PORTAL}/chamados`, { ...corpo, descricao: 'outra coisa' });
    assert.equal(r3.status, 409);
    assert.equal(r3.body.codigo, 'CHAVE_IDEMPOTENCIA_CONFLITO');
  });

  test('concorrência: seis pedidos simultâneos com a mesma chave criam UM chamado (um 201, os demais 200)', async () => {
    const corpo = chamadoValido();
    const rs = await Promise.all(Array.from({ length: 6 }, () => como(a1, 'post', `${PORTAL}/chamados`, corpo)));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 200, 200, 201]);
    assert.equal(new Set(rs.map((r) => r.body.chamado.protocolo)).size, 1);
    assert.equal((await g.um('SELECT count(*)::int AS n FROM suporte_chamados WHERE chave_idempotencia = $1', [corpo.chaveIdempotencia])).n, 1);
  });

  test('o mesmo UUID em usuários diferentes não colide (a chave é por empresa e usuário)', async () => {
    const corpo = chamadoValido();
    assert.equal((await como(a1, 'post', `${PORTAL}/chamados`, corpo)).status, 201);
    assert.equal((await como(a2, 'post', `${PORTAL}/chamados`, corpo)).status, 201);
    assert.equal((await como(b1, 'post', `${PORTAL}/chamados`, corpo)).status, 201);
  });

  test('consulta restrita: cada usuário vê só os próprios; o chamado de outro usuário, de outra empresa ou inexistente é o mesmo 404', async () => {
    const meu = await abrir(a1);
    const doOutro = await abrir(a2);
    const deB = await abrir(b1);
    const lista = await como(a1, 'get', `${PORTAL}/chamados`);
    assert.equal(lista.status, 200);
    const ids = lista.body.itens.map((c) => c.id);
    assert.ok(ids.includes(meu.id));
    assert.ok(!ids.includes(doOutro.id) && !ids.includes(deB.id));
    assert.equal((await como(a1, 'get', `${PORTAL}/chamados/${meu.id}`)).status, 200);
    const sombra = await Promise.all([doOutro.id, deB.id, 999999].map((id) => como(a1, 'get', `${PORTAL}/chamados/${id}`)));
    for (const r of sombra) assert.deepEqual([r.status, r.body.codigo], [404, 'CHAMADO_NAO_ENCONTRADO']);
    assert.deepEqual(new Set(sombra.map((r) => JSON.stringify(r.body))).size, 1, 'mesmo corpo para os três');
    const campos = Object.keys((await como(a1, 'get', `${PORTAL}/chamados/${meu.id}`)).body.chamado).sort();
    assert.ok(!campos.some((c) => /email|empresa|usuario|chave|hash/i.test(c)), `projeção do Portal sem dados internos: ${campos}`);
  });

  test('notificações: conta os chamados com resposta do suporte não lida, independentemente da paginação, por sessão, sem texto e sem marcar como lido', async () => {
    const n1 = await g.contaDaEmpresa(g.empresas.A, 'USUARIO');
    const contar = async (c) => {
      const r = await como(c, 'get', `${PORTAL}/notificacoes`);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body).sort(), ['chamadosNaoLidos', 'status'], 'só a contagem: nenhum texto, protocolo ou id');
      return r.body.chamadosNaoLidos;
    };
    assert.equal(await contar(n1), 0, 'sem chamados');
    const c1 = await abrir(n1, { assunto: 'Primeiro' });
    const c2 = await abrir(n1, { assunto: 'Segundo' });
    assert.equal(await contar(n1), 0, 'chamados sem resposta não contam');
    // Vinte chamados mais novos empurram c1 e c2 para fora da primeira página da listagem (limite 20).
    for (let i = 0; i < 20; i += 1) await abrir(n1, { assunto: `Enchimento ${i}` });
    const primeira = await como(n1, 'get', `${PORTAL}/chamados`);
    assert.ok(!primeira.body.itens.some((c) => c.id === c1.id || c.id === c2.id), 'c1 e c2 ficaram fora da primeira página');

    assert.equal((await painel('post', `${PAINEL}/chamados/${c1.id}/respostas`, { texto: 'Resposta 1 ao primeiro' })).status, 201);
    assert.equal((await painel('post', `${PAINEL}/chamados/${c1.id}/respostas`, { texto: 'Resposta 2 ao primeiro' })).status, 201);
    assert.equal(await contar(n1), 1, 'duas respostas no MESMO chamado contam um chamado');
    assert.equal((await painel('post', `${PAINEL}/chamados/${c2.id}/respostas`, { texto: 'Resposta ao segundo' })).status, 201);
    assert.equal(await contar(n1), 2, 'chamados distintos contam separadamente, mesmo fora da primeira página');
    assert.equal(await contar(n1), 2, 'consultar o contador não marca nada como lido');
    assert.equal(await contar(a2), 0, 'outro usuário da mesma empresa não vê a contagem alheia');
    assert.equal(await contar(b1), 0, 'outra empresa não vê a contagem alheia');

    assert.equal((await como(n1, 'get', `${PORTAL}/chamados/${c1.id}`)).status, 200, 'abrir a conversa é lê-la');
    assert.equal(await contar(n1), 1, 'o chamado lido sai; o outro continua');
    const msg = await como(n1, 'post', `${PORTAL}/chamados/${c1.id}/mensagens`, { texto: 'Obrigado', chaveIdempotencia: uuid() });
    assert.equal(msg.status, 201);
    assert.equal(await contar(n1), 1, 'a própria mensagem do solicitante não conta como não lida');
    assert.equal((await como(n1, 'get', `${PORTAL}/chamados/${c2.id}`)).status, 200);
    assert.equal(await contar(n1), 0, 'tudo lido');
    assert.equal((await painel('post', `${PAINEL}/chamados/${c2.id}/respostas`, { texto: 'Mais uma' })).status, 201);
    assert.equal(await contar(n1), 1, 'resposta nova depois da leitura volta a contar');
    assert.equal((await g.request(g.app).get(`${PORTAL}/notificacoes`)).status, 401, 'sem sessão não há contagem');
  });

  test('XSS: o texto é guardado e devolvido literalmente (o escape é da interface), sem executar nem alterar o armazenado', async () => {
    const carga = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    const c = await abrir(a1, { assunto: carga.slice(0, 40), descricao: carga });
    const lido = await como(a1, 'get', `${PORTAL}/chamados/${c.id}`);
    assert.equal(lido.body.chamado.descricao, carga);
    assert.match(lido.headers['content-type'], /application\/json/);
  });

  test('auditoria: o chamado grava SUPORTE_CHAMADO_ABERTO só com protocolo, categoria e ids; nunca o texto', async () => {
    const segredo = 'texto-sensivel-unico-xyz';
    const c = await abrir(a1, { descricao: `contém ${segredo}`, assunto: `assunto ${segredo}` });
    const linhas = await g.todos("SELECT * FROM logs_auditoria WHERE acao = 'SUPORTE_CHAMADO_ABERTO' AND referencia = $1", [c.protocolo]);
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].empresa_id, g.empresas.A);
    assert.equal(JSON.stringify(linhas[0]).includes(segredo), false);
    const hist = await g.todos('SELECT * FROM suporte_chamado_situacoes WHERE chamado_id = $1', [c.id]);
    assert.deepEqual(hist.map((h) => [h.situacao_anterior, h.situacao_nova]), [[null, 'ABERTO']]);
  });

  test('canais: informa só se o e-mail está cadastrado (nunca o endereço); cada empresa vê o seu', async () => {
    const a = await como(a1, 'get', `${PORTAL}/canais`);
    assert.deepEqual(a.body.canais, { almoxarifado: { configurado: true }, sst: { configurado: true } });
    const b = await como(b1, 'get', `${PORTAL}/canais`);
    assert.deepEqual(b.body.canais, { almoxarifado: { configurado: true }, sst: { configurado: false } });
    assert.equal(JSON.stringify([a.body, b.body]).includes('example.invalid'), false);
  });

  test('contato: o destinatário vem do cadastro da empresa da sessão (A e B diferentes); envio confirmado só quando o transporte confirma', async () => {
    modo = 'ENVIADO';
    envios.length = 0;
    const ra = await como(a1, 'post', `${PORTAL}/contatos/almoxarifado`, contatoValido());
    assert.equal(ra.status, 201, JSON.stringify(ra.body));
    assert.equal(ra.body.contato.situacaoEnvio, 'ENVIO_CONFIRMADO');
    assert.equal(ra.body.contato.entregaConfirmada, true);
    const rb = await como(b1, 'post', `${PORTAL}/contatos/almoxarifado`, contatoValido());
    assert.equal(rb.body.contato.situacaoEnvio, 'ENVIO_CONFIRMADO');
    const rs = await como(a1, 'post', `${PORTAL}/contatos/sst`, contatoValido());
    assert.equal(rs.body.contato.canal, 'SST');
    assert.deepEqual(envios.map((m) => m.para), ['almox.a@example.invalid', 'almox.b@example.invalid', 'sst.a@example.invalid']);
    assert.ok(envios.every((m) => m.tipo === 'CONTATO_SUPORTE' && m.escopo === 'PORTAL'));
    assert.doesNotMatch(envios[0].conteudo.assunto, /Falta de luva/, 'o assunto do e-mail não leva dado do usuário');
    assert.match(envios[0].conteudo.texto, /Falta de luva/);
    assert.equal(JSON.stringify([ra.body, rb.body, rs.body]).includes('example.invalid'), false, 'o destinatário nunca volta ao cliente');
  });

  test('contato: destinatário, empresa, canal por corpo e campos extras são recusados; empresa sem o e-mail recebe orientação e nada é registrado nem enviado', async () => {
    envios.length = 0;
    for (const extra of [{ para: 'x@y.test' }, { destinatario: 'x@y.test' }, { empresaId: g.empresas.B }, { canal: 'SST' }, { emailSst: 'x@y.test' }]) {
      assert.equal((await como(a1, 'post', `${PORTAL}/contatos/sst`, contatoValido(extra))).status, 400, JSON.stringify(extra));
    }
    assert.equal((await como(a1, 'post', `${PORTAL}/contatos/outro`, contatoValido())).status, 400);
    const antes = (await g.um('SELECT count(*)::int AS n FROM suporte_contatos WHERE empresa_id = $1', [g.empresas.B])).n;
    const r = await como(b1, 'post', `${PORTAL}/contatos/sst`, contatoValido());
    assert.deepEqual([r.status, r.body.codigo], [409, 'DESTINATARIO_NAO_CONFIGURADO']);
    assert.match(r.body.message, /Dados da Empresa/);
    assert.equal((await g.um('SELECT count(*)::int AS n FROM suporte_contatos WHERE empresa_id = $1', [g.empresas.B])).n, antes);
    assert.equal(envios.length, 0);
  });

  test('contato: sem provedor ou em arquivo NÃO é entrega; falha do provedor vira FALHA com código técnico; nunca sucesso sem confirmação', async () => {
    for (const [transporte, situacao, confirmada] of [['NAO_ENVIADO', 'NAO_ENVIADO', false], ['GRAVADO', 'GRAVADO_EM_ARQUIVO', false], ['FALHA', 'FALHA', false]]) {
      modo = transporte;
      const r = await como(a1, 'post', `${PORTAL}/contatos/almoxarifado`, contatoValido());
      assert.equal(r.status, 201);
      assert.deepEqual([r.body.contato.situacaoEnvio, r.body.contato.entregaConfirmada], [situacao, confirmada], transporte);
      const linha = await g.um('SELECT situacao_envio, codigo_falha, tentativas FROM suporte_contatos WHERE id = $1', [r.body.contato.id]);
      assert.equal(linha.situacao_envio, situacao);
      assert.equal(linha.codigo_falha, situacao === 'FALHA' ? 'ETIMEDOUT' : null);
      assert.equal(linha.tentativas, 1);
    }
    modo = 'ENVIADO';
  });

  test('contato: idempotência e concorrência — a mesma chave registra e envia UMA vez; outro conteúdo com a mesma chave é 409', async () => {
    modo = 'ENVIADO';
    envios.length = 0;
    const corpo = contatoValido();
    const rs = await Promise.all(Array.from({ length: 5 }, () => como(a1, 'post', `${PORTAL}/contatos/sst`, corpo)));
    assert.equal(rs.filter((r) => r.status === 201).length, 1, JSON.stringify(rs.map((r) => r.status)));
    assert.ok(rs.every((r) => [200, 201].includes(r.status)));
    assert.equal(envios.length, 1, 'um único envio');
    assert.equal((await g.um('SELECT count(*)::int AS n FROM suporte_contatos WHERE chave_idempotencia = $1', [corpo.chaveIdempotencia])).n, 1);
    assert.equal((await como(a1, 'post', `${PORTAL}/contatos/sst`, { ...corpo, mensagem: 'outro texto' })).status, 409);
    assert.equal(envios.length, 1);
  });

  test('contato: a auditoria leva ids, canal e situação, nunca a mensagem, o assunto nem o e-mail', async () => {
    const segredo = 'mensagem-sensivel-unica-abc';
    const r = await como(a1, 'post', `${PORTAL}/contatos/almoxarifado`, contatoValido({ mensagem: segredo, assunto: `a ${segredo}` }));
    const linhas = await g.todos("SELECT * FROM logs_auditoria WHERE acao LIKE 'SUPORTE_CONTATO%' AND referencia = $1", [`ALMOXARIFADO:${r.body.contato.id}`]);
    assert.deepEqual(linhas.map((l) => l.acao).sort(), ['SUPORTE_CONTATO_ENVIO', 'SUPORTE_CONTATO_REGISTRADO']);
    const texto = JSON.stringify(linhas);
    assert.equal(texto.includes(segredo) || texto.includes('example.invalid'), false);
  });

  test('contato: o e-mail não é conteúdo executável — o corpo do e-mail escapa HTML do usuário', async () => {
    envios.length = 0;
    await como(a1, 'post', `${PORTAL}/contatos/sst`, contatoValido({ mensagem: '<script>alert(1)</script>' }));
    assert.doesNotMatch(envios[0].conteudo.html, /<script>alert/);
    assert.match(envios[0].conteudo.html, /&lt;script&gt;/);
  });

  // ---------- Painel Privado ----------

  test('Painel: a fila enxerga chamados de todas as empresas, com filtros e paginação, e o detalhe traz solicitante e empresa', async () => {
    const c = await abrir(a2, { assunto: 'Painel busca unica-zeta' });
    const r = await painel('get', `${PAINEL}/chamados?busca=unica-zeta`);
    assert.equal(r.status, 200);
    assert.deepEqual(r.body.itens.map((i) => i.id), [c.id]);
    assert.equal(r.body.itens[0].empresa.id, g.empresas.A);
    const deB = await abrir(b1);
    const todos = await painel('get', `${PAINEL}/chamados?limite=100`);
    assert.ok(todos.body.itens.some((i) => i.id === deB.id) && todos.body.itens.some((i) => i.id === c.id));
    assert.ok((await painel('get', `${PAINEL}/chamados?empresaId=${g.empresas.B}&limite=100`)).body.itens.every((i) => i.empresa.id === g.empresas.B));
    assert.equal((await painel('get', `${PAINEL}/chamados?situacao=INVALIDA`)).status, 400);
    const d = await painel('get', `${PAINEL}/chamados/${c.id}`);
    assert.equal(d.status, 200);
    assert.equal(d.body.chamado.solicitante.email.length > 0, true);
    assert.equal((await painel('get', `${PAINEL}/chamados/999999`)).status, 404);
  });

  test('Painel: responder grava a resposta, leva a RESPONDIDO, audita sem o texto e o solicitante a vê no Portal', async () => {
    const c = await abrir(a1);
    const segredo = 'resposta-sensivel-unica-q';
    const r = await painel('post', `${PAINEL}/chamados/${c.id}/respostas`, { texto: `Já corrigimos. ${segredo}` });
    assert.deepEqual([r.status, r.body.situacao], [201, 'RESPONDIDO']);
    const doUsuario = await como(a1, 'get', `${PORTAL}/chamados/${c.id}`);
    assert.equal(doUsuario.body.chamado.situacao, 'RESPONDIDO');
    assert.equal(doUsuario.body.respostas.length, 1);
    assert.match(doUsuario.body.respostas[0].texto, /Já corrigimos/);
    assert.equal(doUsuario.body.respostas[0].autor, 'SAFEWORK');
    assert.ok(!('administrador_id' in doUsuario.body.respostas[0]) && !('administradorId' in doUsuario.body.respostas[0]));
    assert.deepEqual(doUsuario.body.historico.map((h) => [h.de, h.para]), [[null, 'ABERTO'], ['ABERTO', 'RESPONDIDO']]);
    const outroUsuario = await como(a2, 'get', `${PORTAL}/chamados/${c.id}`);
    assert.equal(outroUsuario.status, 404, 'o colega da mesma empresa não vê a resposta');
    const aud = await g.todos("SELECT * FROM logs_auditoria_plataforma WHERE acao = 'SUPORTE_CHAMADO_RESPONDIDO' AND referencia = $1", [c.protocolo]);
    assert.equal(aud.length, 1);
    assert.equal(aud[0].empresa_afetada_id, g.empresas.A);
    assert.equal(JSON.stringify(aud).includes(segredo), false);
    assert.equal((await painel('post', `${PAINEL}/chamados/${c.id}/respostas`, { texto: '   ' })).status, 400);
    assert.equal((await painel('post', `${PAINEL}/chamados/${c.id}/respostas`, { texto: 'x', administradorId: 9 })).status, 400);
  });

  // ---------- Conversa (093) ----------

  test('conversa: o solicitante responde no próprio chamado (autor SOLICITANTE), o Painel vê a mensagem como não lida e o chamado volta a ABERTO depois de RESPONDIDO, com histórico', async () => {
    const c = await abrir(a1);
    await painel('post', `${PAINEL}/chamados/${c.id}/respostas`, { texto: 'Pode detalhar?' });
    const lista = await como(a1, 'get', `${PORTAL}/chamados`);
    assert.equal(lista.body.itens.find((i) => i.id === c.id).naoLidas, 1, 'a resposta do suporte conta como não lida para o solicitante');
    const detalhe = await como(a1, 'get', `${PORTAL}/chamados/${c.id}`);
    assert.deepEqual(detalhe.body.mensagens.map((m) => m.autor), ['SAFEWORK']);
    assert.equal(detalhe.body.chamado.naoLidas, 0, 'abrir é ler');
    assert.equal((await como(a1, 'get', `${PORTAL}/chamados`)).body.itens.find((i) => i.id === c.id).naoLidas, 0);
    const r = await como(a1, 'post', `${PORTAL}/chamados/${c.id}/mensagens`, { texto: 'Claro: acontece ao salvar.', chaveIdempotencia: uuid() });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.deepEqual([r.body.mensagem.autor, r.body.situacao, r.body.repetido], ['SOLICITANTE', 'ABERTO', false]);
    const linha = await g.um('SELECT autor_tipo, administrador_id, usuario_id, usuario_empresa_id FROM suporte_chamado_respostas WHERE id = $1', [r.body.mensagem.id]);
    assert.deepEqual(linha, { autor_tipo: 'SOLICITANTE', administrador_id: null, usuario_id: a1.usuarioId, usuario_empresa_id: g.empresas.A });
    const fila = await painel('get', `${PAINEL}/chamados?naoLidas=true&limite=100`);
    const naFila = fila.body.itens.find((i) => i.id === c.id);
    assert.equal(naFila.naoLidas, 1, 'o Painel vê a mensagem do solicitante como não lida');
    assert.equal(naFila.situacao, 'ABERTO');
    const hist = await g.todos('SELECT situacao_anterior AS de, situacao_nova AS para, administrador_id FROM suporte_chamado_situacoes WHERE chamado_id = $1 ORDER BY id', [c.id]);
    assert.deepEqual(hist.map((h) => [h.de, h.para, h.administrador_id]), [[null, 'ABERTO', null], ['ABERTO', 'RESPONDIDO', hist[1].administrador_id], ['RESPONDIDO', 'ABERTO', null]]);
    const d = await painel('get', `${PAINEL}/chamados/${c.id}`);
    assert.deepEqual(d.body.mensagens.map((m) => m.autor), ['SAFEWORK', 'SOLICITANTE']);
    assert.equal((await painel('get', `${PAINEL}/chamados?limite=100`)).body.itens.find((i) => i.id === c.id).naoLidas, 0, 'abrir no Painel é ler');
  });

  test('conversa: leitura incremental (?aposId) nos dois lados, ordem estável por id, situação atual junto', async () => {
    const c = await abrir(a1);
    const m1 = (await como(a1, 'post', `${PORTAL}/chamados/${c.id}/mensagens`, { texto: 'primeira', chaveIdempotencia: uuid() })).body.mensagem;
    const m2 = (await painel('post', `${PAINEL}/chamados/${c.id}/respostas`, { texto: 'segunda', chaveIdempotencia: uuid() })).body.mensagem;
    const m3 = (await como(a1, 'post', `${PORTAL}/chamados/${c.id}/mensagens`, { texto: 'terceira', chaveIdempotencia: uuid() })).body.mensagem;
    assert.ok(m1.id < m2.id && m2.id < m3.id);
    const todas = await como(a1, 'get', `${PORTAL}/chamados/${c.id}/mensagens`);
    assert.deepEqual(todas.body.mensagens.map((m) => m.texto), ['primeira', 'segunda', 'terceira']);
    const novas = await como(a1, 'get', `${PORTAL}/chamados/${c.id}/mensagens?aposId=${m1.id}`);
    assert.deepEqual(novas.body.mensagens.map((m) => m.id), [m2.id, m3.id]);
    assert.equal(novas.body.situacao, 'ABERTO');
    const nadaNovo = await painel('get', `${PAINEL}/chamados/${c.id}/mensagens?aposId=${m3.id}`);
    assert.deepEqual(nadaNovo.body.mensagens, []);
    assert.equal((await como(a1, 'get', `${PORTAL}/chamados/${c.id}/mensagens?aposId=abc`)).status, 400);
  });

  test('conversa: idempotência e concorrência — a mesma chave no mesmo chamado grava UMA mensagem (e reabre uma vez só); outro usuário é 404; o Painel com chave também não duplica', async () => {
    const c = await abrir(a1);
    await painel('post', `${PAINEL}/chamados/${c.id}/respostas`, { texto: 'ok' });
    const corpo = { texto: 'reenvio', chaveIdempotencia: uuid() };
    const rs = await Promise.all(Array.from({ length: 5 }, () => como(a1, 'post', `${PORTAL}/chamados/${c.id}/mensagens`, corpo)));
    assert.deepEqual(rs.map((r) => r.status).sort(), [200, 200, 200, 200, 201]);
    assert.equal(new Set(rs.map((r) => r.body.mensagem.id)).size, 1);
    assert.equal((await g.um("SELECT count(*)::int AS n FROM suporte_chamado_respostas WHERE chamado_id = $1 AND autor_tipo = 'SOLICITANTE'", [c.id])).n, 1);
    assert.equal((await g.um("SELECT count(*)::int AS n FROM suporte_chamado_situacoes WHERE chamado_id = $1 AND situacao_nova = 'ABERTO'", [c.id])).n, 2, 'abertura inicial + uma reabertura');
    assert.equal((await como(a2, 'post', `${PORTAL}/chamados/${c.id}/mensagens`, { texto: 'invasor', chaveIdempotencia: uuid() })).status, 404);
    assert.equal((await como(b1, 'post', `${PORTAL}/chamados/${c.id}/mensagens`, { texto: 'invasor', chaveIdempotencia: uuid() })).status, 404);
    const chaveAdmin = uuid();
    const p1 = await painel('post', `${PAINEL}/chamados/${c.id}/respostas`, { texto: 'dup', chaveIdempotencia: chaveAdmin });
    const p2 = await painel('post', `${PAINEL}/chamados/${c.id}/respostas`, { texto: 'dup', chaveIdempotencia: chaveAdmin });
    assert.deepEqual([p1.status, p2.status, p2.body.repetido], [201, 200, true]);
    assert.equal(p1.body.mensagem.id, p2.body.mensagem.id);
    for (const ruim of [{ texto: '' }, { texto: 'x', chaveIdempotencia: 'nao-uuid' }, { texto: 'x', chaveIdempotencia: uuid(), autor: 'SAFEWORK' }]) {
      assert.equal((await como(a1, 'post', `${PORTAL}/chamados/${c.id}/mensagens`, ruim)).status, 400, JSON.stringify(ruim));
    }
  });

  test('conversa: auditoria da mensagem só com ids e protocolo; o banco recusa mensagem de solicitante que não é o dono', async () => {
    const c = await abrir(a1);
    const segredo = 'mensagem-privada-zz';
    await como(a1, 'post', `${PORTAL}/chamados/${c.id}/mensagens`, { texto: segredo, chaveIdempotencia: uuid() });
    const aud = await g.todos("SELECT * FROM logs_auditoria WHERE acao = 'SUPORTE_CHAMADO_MENSAGEM' AND referencia = $1", [c.protocolo]);
    assert.equal(aud.length, 1);
    assert.equal(JSON.stringify(aud).includes(segredo), false);
    await assert.rejects(g.pool.query(
      "INSERT INTO suporte_chamado_respostas (chamado_id, autor_tipo, usuario_empresa_id, usuario_id, texto) VALUES ($1, 'SOLICITANTE', $2, $3, 'x')",
      [c.id, g.empresas.A, a2.usuarioId],
    ), /solicitante do chamado/);
  });

  test('conversa: chamado ENCERRADO continua legível, mas não recebe mensagem de nenhum lado até a reabertura pelo administrador (ENCERRADO → ABERTO), que é auditada', async () => {
    const c = await abrir(a1);
    await como(a1, 'post', `${PORTAL}/chamados/${c.id}/mensagens`, { texto: 'antes', chaveIdempotencia: uuid() });
    assert.equal((await painel('patch', `${PAINEL}/chamados/${c.id}/situacao`, { situacao: 'ENCERRADO' })).status, 200);
    const leitura = await como(a1, 'get', `${PORTAL}/chamados/${c.id}`);
    assert.deepEqual([leitura.status, leitura.body.chamado.situacao, leitura.body.mensagens.length], [200, 'ENCERRADO', 1]);
    const bloqueado = await como(a1, 'post', `${PORTAL}/chamados/${c.id}/mensagens`, { texto: 'depois', chaveIdempotencia: uuid() });
    assert.deepEqual([bloqueado.status, bloqueado.body.codigo], [409, 'CHAMADO_ENCERRADO']);
    assert.equal((await painel('post', `${PAINEL}/chamados/${c.id}/respostas`, { texto: 'tarde' })).status, 409);
    for (const s of ['EM_ATENDIMENTO', 'RESPONDIDO']) assert.equal((await painel('patch', `${PAINEL}/chamados/${c.id}/situacao`, { situacao: s })).body.codigo, 'CHAMADO_ENCERRADO', s);
    const reaberto = await painel('patch', `${PAINEL}/chamados/${c.id}/situacao`, { situacao: 'ABERTO' });
    assert.deepEqual([reaberto.status, reaberto.body.alterado], [200, true]);
    assert.equal((await g.um('SELECT encerrado_em FROM suporte_chamados WHERE id = $1', [c.id])).encerrado_em, null);
    const aud = await g.todos("SELECT contexto FROM logs_auditoria_plataforma WHERE acao = 'SUPORTE_CHAMADO_SITUACAO_ALTERADA' AND referencia = $1 ORDER BY id", [c.protocolo]);
    assert.equal(aud.at(-1).contexto.reabertura, true);
    assert.equal((await como(a1, 'post', `${PORTAL}/chamados/${c.id}/mensagens`, { texto: 'de novo', chaveIdempotencia: uuid() })).status, 201);
    const hist = await g.todos('SELECT situacao_nova AS para FROM suporte_chamado_situacoes WHERE chamado_id = $1 ORDER BY id', [c.id]);
    assert.deepEqual(hist.map((h) => h.para), ['ABERTO', 'ENCERRADO', 'ABERTO']);
  });

  test('Painel: situação ABERTO → EM_ATENDIMENTO → ENCERRADO com histórico; ENCERRADO é final para mensagens e só sai para ABERTO; repetir é inofensivo', async () => {
    const c = await abrir(a1);
    const em = await painel('patch', `${PAINEL}/chamados/${c.id}/situacao`, { situacao: 'EM_ATENDIMENTO' });
    assert.deepEqual([em.status, em.body.alterado], [200, true]);
    assert.deepEqual((await painel('patch', `${PAINEL}/chamados/${c.id}/situacao`, { situacao: 'EM_ATENDIMENTO' })).body.alterado, false);
    const fim = await painel('patch', `${PAINEL}/chamados/${c.id}/situacao`, { situacao: 'ENCERRADO' });
    assert.equal(fim.body.alterado, true);
    const linha = await g.um('SELECT situacao, encerrado_em FROM suporte_chamados WHERE id = $1', [c.id]);
    assert.equal(linha.situacao, 'ENCERRADO');
    assert.ok(linha.encerrado_em);
    assert.deepEqual((await painel('patch', `${PAINEL}/chamados/${c.id}/situacao`, { situacao: 'RESPONDIDO' })).body.codigo, 'CHAMADO_ENCERRADO');
    assert.equal((await painel('post', `${PAINEL}/chamados/${c.id}/respostas`, { texto: 'tarde demais' })).status, 409);
    assert.equal((await painel('patch', `${PAINEL}/chamados/${c.id}/situacao`, { situacao: 'QUALQUER' })).status, 400);
    const hist = await g.todos('SELECT situacao_anterior AS de, situacao_nova AS para FROM suporte_chamado_situacoes WHERE chamado_id = $1 ORDER BY id', [c.id]);
    assert.deepEqual(hist.map((h) => [h.de, h.para]), [[null, 'ABERTO'], ['ABERTO', 'EM_ATENDIMENTO'], ['EM_ATENDIMENTO', 'ENCERRADO']]);
    assert.equal((await g.todos("SELECT 1 FROM logs_auditoria_plataforma WHERE acao = 'SUPORTE_CHAMADO_SITUACAO_ALTERADA' AND referencia = $1", [c.protocolo])).length, 2);
  });

  test('Painel: resposta e encerramento simultâneos se serializam — o histórico fica coerente e nunca há resposta depois do encerramento', async () => {
    for (let i = 0; i < 4; i += 1) {
      const c = await abrir(a1);
      const [r, e] = await Promise.all([
        painel('post', `${PAINEL}/chamados/${c.id}/respostas`, { texto: `corrida ${i}` }),
        painel('patch', `${PAINEL}/chamados/${c.id}/situacao`, { situacao: 'ENCERRADO' }),
      ]);
      assert.ok([201, 409].includes(r.status), `resposta ${r.status}`);
      assert.equal(e.status, 200, 'o encerramento sempre vence: nada o impede');
      const final = await g.um('SELECT situacao, encerrado_em FROM suporte_chamados WHERE id = $1', [c.id]);
      const hist = await g.todos('SELECT situacao_nova AS para FROM suporte_chamado_situacoes WHERE chamado_id = $1 ORDER BY id', [c.id]);
      assert.equal(hist.at(-1).para, final.situacao, 'o último histórico é a situação atual');
      const respostas = await g.todos('SELECT criado_em FROM suporte_chamado_respostas WHERE chamado_id = $1', [c.id]);
      assert.equal(respostas.length, r.status === 201 ? 1 : 0);
      if (final.situacao === 'ENCERRADO') assert.ok(respostas.every((x) => x.criado_em <= final.encerrado_em));
      assert.equal(final.situacao, 'ENCERRADO');
    }
  });

  test('banco: respostas e histórico são imutáveis e o chamado não troca de dono', async () => {
    const c = await abrir(a1);
    await painel('post', `${PAINEL}/chamados/${c.id}/respostas`, { texto: 'ok' });
    await assert.rejects(g.pool.query('UPDATE suporte_chamado_respostas SET texto = $1 WHERE chamado_id = $2', ['x', c.id]), /imutável/);
    await assert.rejects(g.pool.query('DELETE FROM suporte_chamado_situacoes WHERE chamado_id = $1', [c.id]), /imutável/);
    await assert.rejects(g.pool.query('UPDATE suporte_chamados SET usuario_id = $1 WHERE id = $2', [b1.usuarioId, c.id]), /fk_suporte_chamados_usuario_mesma_empresa/);
  });

  test('banco: não existe chamado ou contato ligado a usuário de outra empresa (FK composta)', async () => {
    await assert.rejects(g.pool.query(
      `INSERT INTO suporte_chamados (empresa_id, usuario_id, assunto, categoria, descricao, solicitante_nome, solicitante_email, chave_idempotencia, requisicao_hash)
       VALUES ($1, $2, 'a', 'ERRO', 'd', 'n', 'e@x.test', $3, repeat('a', 64))`,
      [g.empresas.A, b1.usuarioId, uuid()],
    ), /fk_suporte_chamados_usuario_mesma_empresa/);
    await assert.rejects(g.pool.query(
      `INSERT INTO suporte_contatos (empresa_id, usuario_id, canal, assunto, mensagem, chave_idempotencia, requisicao_hash)
       VALUES ($1, $2, 'SST', 'a', 'm', $3, repeat('a', 64))`,
      [g.empresas.A, b1.usuarioId, uuid()],
    ), /fk_suporte_contatos_usuario_mesma_empresa/);
  });
});
