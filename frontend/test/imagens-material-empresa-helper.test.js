'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('./helpers/imagens-material-empresa');
const { abrirPagina } = require('./helpers/dom-pagina');

/**
 * Unidade 5C-7 — AUTOTESTE do auxiliar helpers/imagens-material-empresa.js: a biblioteca simulada segue o contrato lido no backend (lista conjunta e paginada, envio e
 * deduplicação, renomear, inativar, reativar, excluir, associação ao material) e o auxiliar de página intercepta o envio binário e acha os controles pelo nome acessível.
 * Verdes desde o nascimento: sem eles, um RED poderia falhar (ou passar) por defeito do simulador e não do produto.
 */

const empresa = (n, extra = {}) => Array.from({ length: n }, (_, i) => ({ id: String(i + 1), nome: `Imagem ${String(i + 1).padStart(3, '0')}`, ...extra }));
const consultar = (b, caminho) => b.listar(`${E.API}${caminho}`).corpo;

describe('5C-7 auxiliar — arquivos e respostas falsas', () => {
  test('arquivo() devolve um File de verdade com nome, tipo e tamanho pedidos; arquivos() gera conteúdos distintos', async () => {
    const a = E.arquivo({ nome: 'x.webp', tipo: 'image/webp', tamanho: 10 });
    assert.deepEqual([a.name, a.type, a.size], ['x.webp', 'image/webp', 10]);
    const lote = E.arquivos(3);
    assert.equal(new Set(await Promise.all(lote.map(E.sha256Do))).size, 3);
    assert.equal(E.arquivo({ tamanho: 0 }).size, 0);
  });

  test('resposta() consulta cabeçalhos sem diferenciar maiúsculas e pode falhar na leitura do corpo', async () => {
    const r = E.resposta(429, { codigo: 'x' }, { cabecalhos: { 'Retry-After': '30' } });
    assert.equal(r.headers.get('retry-after'), '30');
    assert.equal(r.headers.get('RETRY-AFTER'), '30');
    assert.equal(r.headers.get('x-outro'), null);
    assert.deepEqual(JSON.parse(await r.text()), { codigo: 'x' });
    await assert.rejects(E.resposta(200, {}, { leituraFalha: true }).text(), TypeError);
  });

  test('fetchRoteirizado consome o roteiro na ordem, mede a concorrência e falha com erro claro quando o roteiro acaba', async () => {
    const { fetch, estado } = E.fetchRoteirizado([E.criada('1'), new TypeError('rede'), async () => E.reaproveitada('2')]);
    assert.equal((await fetch('u1', {})).status, 201);
    await assert.rejects(fetch('u2', {}), TypeError);
    assert.equal((await fetch('u3', {})).status, 200);
    await assert.rejects(fetch('u4', {}), /roteiro esgotado/);
    assert.equal(estado.chamadas.length, 4);
    assert.equal(estado.maxEmVoo, 1);
  });
});

describe('5C-7 auxiliar — lista conjunta como o serviço devolve', () => {
  test('padrão primeiro, depois a empresa; paginadas em conjunto (30 + 130 com limite 100: 30 + 70, depois 60), total fixo e nenhum item repetido', () => {
    const b = E.criarBiblioteca({ empresa: empresa(130) });
    const p1 = consultar(b, '/imagens-material?origem=TODAS&pagina=1&limite=100');
    const p2 = consultar(b, '/imagens-material?origem=TODAS&pagina=2&limite=100');
    assert.deepEqual([p1.total, p1.pagina, p1.limite, p1.imagens.length, p2.imagens.length], [160, 1, 100, 100, 60]);
    assert.deepEqual(p1.imagens.slice(0, 30).map((i) => i.origem), Array(30).fill('PADRAO'));
    assert.deepEqual(p1.imagens.slice(30).map((i) => i.origem), Array(70).fill('EMPRESA'));
    const todas = [...p1.imagens, ...p2.imagens].map((i) => `${i.origem}:${i.id}`);
    assert.equal(new Set(todas).size, 160);
  });

  test('origem=EMPRESA e origem=PADRAO listam só a sua biblioteca; o estado só vale para a empresa; a busca ignora acento e caixa', () => {
    const b = E.criarBiblioteca({ empresa: [{ id: '1', nome: 'Luva Nitrílica' }, { id: '2', nome: 'Bota', estado: 'INATIVA' }] });
    assert.deepEqual(consultar(b, '/imagens-material?origem=EMPRESA').imagens.map((i) => i.id), ['1']);
    assert.deepEqual(consultar(b, '/imagens-material?origem=EMPRESA&estado=INATIVA').imagens.map((i) => i.id), ['2']);
    assert.deepEqual(consultar(b, '/imagens-material?origem=EMPRESA&estado=TODAS').imagens.map((i) => i.id).sort(), ['1', '2']);
    assert.equal(consultar(b, '/imagens-material?origem=PADRAO&limite=100').imagens.length, 30);
    assert.deepEqual(consultar(b, '/imagens-material?origem=EMPRESA&busca=NITRILICA').imagens.map((i) => i.id), ['1']);
  });

  test('o contrato da consulta é estrito: chave desconhecida, origem, estado, página e limite fora do permitido são 400', () => {
    const b = E.criarBiblioteca();
    for (const consulta of ['x=1', 'origem=OUTRA', 'estado=ZZZ', 'pagina=0', 'limite=101', 'limite=0', 'pagina=10001']) {
      assert.equal(b.listar(`${E.API}/imagens-material?${consulta}`).status, 400, consulta);
    }
  });

  test('item da empresa traz a projeção pública (sem hash) mais sugerida=null e emUso; o da padrão traz emUso da própria empresa', () => {
    const b = E.criarBiblioteca({ empresa: [{ id: '9', nome: 'Capa' }] });
    b.materiais.set(1, { id: 1, imagem: { origem: 'EMPRESA', id: '9' } });
    b.materiais.set(2, { id: 2, imagem: { origem: 'EMPRESA', id: '9' } });
    b.materiais.set(3, { id: 3, imagem: { origem: 'PADRAO', id: '1001' } });
    const { imagens } = consultar(b, '/imagens-material?origem=TODAS&limite=100');
    const empresaItem = imagens.find((i) => i.origem === 'EMPRESA');
    assert.deepEqual(Object.keys(empresaItem).sort(), ['altura', 'emUso', 'estado', 'formato', 'id', 'largura', 'nome', 'origem', 'sugerida', 'versao']);
    assert.equal(empresaItem.emUso, 2);
    assert.equal(imagens.find((i) => i.id === '1001').emUso, 1);
    assert.equal(JSON.stringify(imagens).includes('sha'), false);
  });
});

describe('5C-7 auxiliar — envio, deduplicação e cota', () => {
  const registro = (arq, { nome = 'Luva', tipo = arq.type, consulta = ['nome'] } = {}) => ({ nome, consulta, cabecalhos: { 'content-type': tipo }, corpo: arq });

  test('imagem nova: 201, ATIVA, versão 1, id em texto crescente; o mesmo conteúdo volta 200 reaproveitada (com o nome ORIGINAL) e não cria outra', async () => {
    const b = E.criarBiblioteca({ proximoId: '9007199254740993' });
    const arq = E.arquivo({ semente: 'a' });
    const r1 = await b.enviar(registro(arq, { nome: '  Luva  ' }));
    assert.equal(r1.status, 201);
    assert.deepEqual(r1.corpo.imagem, { origem: 'EMPRESA', id: '9007199254740993', nome: 'Luva', formato: 'PNG', largura: 1024, altura: 1024, versao: 1, estado: 'ATIVA' });
    assert.equal(r1.corpo.reaproveitada, false);
    const r2 = await b.enviar(registro(E.arquivo({ semente: 'a', nome: 'copia.png' }), { nome: 'Outro nome' }));
    assert.equal(r2.status, 200);
    assert.equal(r2.corpo.reaproveitada, true);
    assert.equal(r2.corpo.imagem.nome, 'Luva');
    const r3 = await b.enviar(registro(E.arquivo({ semente: 'b' })));
    assert.equal(r3.corpo.imagem.id, '9007199254740994');
    assert.equal(b.empresa.length, 2);
  });

  test('recusas na ordem do servidor: tipo de conteúdo 415, acima de 2 MiB 413, chave extra e nome inválido 400, formato 415, vazio 415, cota 409, sem permissão 403', async () => {
    const b = E.criarBiblioteca({ cotaImagens: 1 });
    assert.deepEqual(await b.enviar(registro(E.arquivo(), { tipo: 'application/json' })).then((r) => [r.status, r.corpo.codigo]), [415, 'TIPO_CONTEUDO_NAO_SUPORTADO']);
    assert.deepEqual(await b.enviar(registro(E.arquivo({ tamanho: 2 * E.MIB + 1 }))).then((r) => [r.status, r.corpo.codigo]), [413, 'PAYLOAD_MUITO_GRANDE']);
    assert.deepEqual(await b.enviar(registro(E.arquivo(), { consulta: ['nome', 'empresaId'] })).then((r) => [r.status, r.corpo.codigo]), [400, 'VALIDACAO']);
    for (const nome of ['', '   ', 'x'.repeat(101), 'a\u0007b']) {
      const r = await b.enviar(registro(E.arquivo(), { nome }));
      assert.deepEqual([r.status, r.corpo.detalhes[0].campo, r.corpo.detalhes[0].codigo], [400, 'query.nome', 'NOME_INVALIDO'], JSON.stringify(nome));
    }
    assert.equal((await b.enviar(registro(E.arquivo({ nome: 'x.gif', tipo: 'image/gif' })))).corpo.codigo, 'IMAGEM_FORMATO_NAO_SUPORTADO');
    assert.equal((await b.enviar(registro(E.arquivo({ tamanho: 0 })))).corpo.codigo, 'IMAGEM_FORMATO_NAO_SUPORTADO');
    assert.equal((await b.enviar(registro(E.arquivo({ semente: '1' })))).status, 201);
    assert.deepEqual(await b.enviar(registro(E.arquivo({ semente: '2' }))).then((r) => [r.status, r.corpo.codigo]), [409, 'IMAGEM_COTA_EXCEDIDA']);
    b.permissoes = E.H.permissoes({ materials: { visualizar: true, criar: false, editar: true, excluir: false } });
    assert.equal((await b.enviar(registro(E.arquivo({ semente: '3' })))).status, 403);
    assert.equal(JSON.stringify(b.empresa).includes(E.TEXTO_DO_SERVIDOR), false);
  });

  test('o roteiro de envio força respostas na ordem (objeto ou função) antes de qualquer regra', async () => {
    const b = E.criarBiblioteca();
    b.roteiroEnvio.push({ status: 429, corpo: { status: 'error', codigo: 'LIMITE_REQUISICOES_EXCEDIDO' }, cabecalhos: { 'Retry-After': '20' } }, () => ({ status: 503, corpo: { codigo: 'IMAGENS_OCUPADO' } }));
    assert.equal((await b.enviar(registro(E.arquivo()))).status, 429);
    assert.equal((await b.enviar(registro(E.arquivo()))).status, 503);
    assert.equal((await b.enviar(registro(E.arquivo()))).status, 201);
  });

  test('null no roteiro deixa aquele envio seguir a regra normal; erroDeEnvio monta a resposta de erro com cabeçalhos e detalhes opcionais', async () => {
    const b = E.criarBiblioteca();
    const limite = E.erroDeEnvio(429, 'LIMITE_REQUISICOES_EXCEDIDO', { cabecalhos: { 'Retry-After': '30' } });
    assert.deepEqual(limite, { status: 429, corpo: { status: 'error', codigo: 'LIMITE_REQUISICOES_EXCEDIDO', message: E.TEXTO_DO_SERVIDOR }, cabecalhos: { 'Retry-After': '30' } });
    assert.deepEqual(E.erroDeEnvio(400, 'VALIDACAO', { detalhes: [{ campo: 'query.nome', codigo: 'NOME_INVALIDO', mensagem: 'x' }] }).corpo.detalhes, [{ campo: 'query.nome', codigo: 'NOME_INVALIDO', mensagem: 'x' }]);
    assert.equal('cabecalhos' in E.erroDeEnvio(415, 'X'), false);
    b.roteiroEnvio.push(null, limite, new TypeError('Failed to fetch'));
    assert.equal((await b.enviar(registro(E.arquivo({ semente: 'um' })))).status, 201, 'null = regra normal');
    assert.equal((await b.enviar(registro(E.arquivo({ semente: 'dois' })))).status, 429);
    assert.ok((await b.enviar(registro(E.arquivo({ semente: 'tres' })))) instanceof TypeError, 'um Error no roteiro vira falha de rede');
    assert.equal((await b.enviar(registro(E.arquivo({ semente: 'quatro' })))).status, 201, 'roteiro esgotado volta à regra normal');
    assert.equal(b.empresa.length, 2);
  });
});

describe('5C-7 auxiliar — gerenciar a biblioteca da empresa', () => {
  test('renomear: alterado só quando muda, nome inválido 400, corpo com chave extra 400, inexistente 404, sem editar 403', () => {
    const b = E.criarBiblioteca({ empresa: [{ id: '5', nome: 'Antiga' }] });
    assert.deepEqual([b.renomear('5', { nome: ' Nova ' }).corpo.alterado, b.acharEmpresa('5').nome], [true, 'Nova']);
    assert.equal(b.renomear('5', { nome: 'Nova' }).corpo.alterado, false);
    assert.equal(b.renomear('5', { nome: '' }).status, 400);
    assert.equal(b.renomear('5', { nome: 'x', estado: 'INATIVA' }).status, 400);
    assert.deepEqual([b.renomear('99', { nome: 'x' }).status, b.renomear('99', { nome: 'x' }).corpo.codigo], [404, 'IMAGEM_NAO_ENCONTRADA']);
    b.permissoes = E.H.permissoes({ materials: { visualizar: true, criar: true, editar: false, excluir: false } });
    assert.equal(b.renomear('5', { nome: 'y' }).status, 403);
  });

  test('inativar: 409 IMAGEM_EM_USO com material usando, idempotente, reativar nunca é bloqueado; corpo precisa ser {}', () => {
    const b = E.criarBiblioteca({ empresa: [{ id: '5', nome: 'A' }, { id: '6', nome: 'B' }] });
    b.materiais.set(1, { id: 1, imagem: { origem: 'EMPRESA', id: '5' } });
    assert.deepEqual([b.mudarEstado('5', 'INATIVA', {}).status, b.mudarEstado('5', 'INATIVA', {}).corpo.codigo], [409, 'IMAGEM_EM_USO']);
    assert.equal(b.mudarEstado('6', 'INATIVA', {}).corpo.alterado, true);
    assert.equal(b.mudarEstado('6', 'INATIVA', {}).corpo.alterado, false);
    assert.equal(b.mudarEstado('6', 'ATIVA', {}).corpo.alterado, true);
    assert.equal(b.mudarEstado('6', 'INATIVA', undefined).status, 400);
    assert.equal(b.mudarEstado('6', 'INATIVA', { x: 1 }).status, 400);
  });

  test('excluir: exige exatamente { confirmacao: true }; 409 em uso; some da lista e libera a cota; inexistente 404', () => {
    const b = E.criarBiblioteca({ empresa: [{ id: '5', nome: 'A' }, { id: '6', nome: 'B' }] });
    b.materiais.set(1, { id: 1, imagem: { origem: 'EMPRESA', id: '5' } });
    for (const corpo of [undefined, {}, { confirmacao: false }, { confirmacao: 'true' }, { confirmacao: true, x: 1 }]) assert.equal(b.excluir('6', corpo).status, 400, JSON.stringify(corpo));
    assert.equal(b.excluir('5', { confirmacao: true }).corpo.codigo, 'IMAGEM_EM_USO');
    assert.deepEqual(b.excluir('6', { confirmacao: true }).corpo, { status: 'ok', excluida: true, imagemId: '6' });
    assert.equal(b.acharEmpresa('6'), null);
    assert.equal(b.excluir('6', { confirmacao: true }).status, 404);
  });
});

describe('5C-7 auxiliar — associação ao material e rotas', () => {
  test('lerImagemDoCorpo: ausente não mexe, null remove, EMPRESA só se ativa, PADRAO existente, forma inválida 400, inexistente 404', () => {
    const b = E.criarBiblioteca({ empresa: [{ id: '5', nome: 'A' }, { id: '6', nome: 'B', estado: 'INATIVA' }] });
    assert.deepEqual(E.lerImagemDoCorpo(b, {}), { imagem: undefined });
    assert.deepEqual(E.lerImagemDoCorpo(b, { imagem: null }), { imagem: null });
    assert.deepEqual(E.lerImagemDoCorpo(b, { imagem: { origem: 'EMPRESA', id: '5' } }).imagem, { origem: 'EMPRESA', id: '5', versao: 1, nome: 'A' });
    assert.equal(E.lerImagemDoCorpo(b, { imagem: { origem: 'EMPRESA', id: '6' } }).resposta.corpo.codigo, 'IMAGEM_NAO_ENCONTRADA');
    assert.equal(E.lerImagemDoCorpo(b, { imagem: { origem: 'EMPRESA', id: '77' } }).resposta.status, 404);
    assert.equal(E.lerImagemDoCorpo(b, { imagem: { origem: 'PADRAO', id: '1001' } }).imagem.nome, E.H.NOMES[0]);
    for (const imagem of ['x', [], { origem: 'EMPRESA' }, { origem: 'OUTRA', id: '1' }, { origem: 'EMPRESA', id: 5 }, { origem: 'EMPRESA', id: '05' }, { origem: 'EMPRESA', id: '5', x: 1 }]) {
      assert.equal(E.lerImagemDoCorpo(b, { imagem }).resposta.status, 400, JSON.stringify(imagem));
    }
  });

  test('o servidor responde às rotas dinâmicas, deixa `respostas` vencer a regra (com acesso a ela) e devolve indefinido para o que não existe', async () => {
    const { rotas, biblioteca: b } = E.servidor({
      biblioteca: E.criarBiblioteca({ empresa: [{ id: '5', nome: 'A' }] }),
      respostas: { 'PATCH /imagens-material/empresa/5': (c, regra) => (c.corpo.nome === 'forcar' ? { status: 500, corpo: { codigo: 'ERRO_INTERNO' } } : regra(c)) },
    });
    assert.equal(rotas['GET /materiais/501']({}).status, 200);
    assert.equal(rotas['GET /materiais/12345']({}).corpo.codigo, 'MATERIAL_NAO_ENCONTRADO');
    assert.equal((await rotas['PATCH /imagens-material/empresa/5']({ corpo: { nome: 'forcar' } })).status, 500);
    assert.equal((await rotas['PATCH /imagens-material/empresa/5']({ corpo: { nome: 'normal' } })).status, 200);
    assert.equal(b.acharEmpresa('5').nome, 'normal');
    assert.equal(rotas['GET /rota/inexistente'], undefined);
    assert.equal(typeof rotas['GET /auth/permissoes'], 'function');
  });
});

describe('5C-7 auxiliar — a página real com o envio binário interceptado', () => {
  test('abrir() carrega materials.html; o GET da lista devolve a biblioteca conjunta; o POST binário é registrado (URL, credenciais, cabeçalhos e o PRÓPRIO File) e respondido pela biblioteca', async () => {
    const { pg, b, envios } = await E.abrir({ biblioteca: E.criarBiblioteca({ empresa: empresa(2) }) });
    const lista = await pg.janela.fetch(`${E.API}/imagens-material?origem=TODAS&pagina=1&limite=100`, { method: 'GET', credentials: 'include' });
    assert.equal((JSON.parse(await lista.text())).total, 32);
    const arq = E.arquivo({ semente: 'p' });
    const r = await pg.janela.fetch(`${E.API}/imagens-material/empresa?nome=${encodeURIComponent('Capa de chuva')}`, { method: 'POST', credentials: 'include', headers: { 'Content-Type': 'image/png' }, body: arq });
    assert.equal(r.status, 201);
    assert.equal(r.ok, true);
    assert.equal(envios.length, 1);
    assert.equal(envios[0].corpo, arq, 'o corpo registrado é o próprio objeto');
    assert.deepEqual([envios[0].nome, envios[0].credentials, envios[0].cabecalhos['content-type'], envios[0].consulta], ['Capa de chuva', 'include', 'image/png', ['nome']]);
    assert.equal(b.empresa.length, 3);
    assert.equal(pg.chamadas.some((c) => c.metodo === 'POST' && /imagens-material\/empresa/.test(c.caminho)), false, 'o POST binário não passa pelo harness JSON');
  });

  test('segurarEnvios() mantém o envio em andamento até liberar(); b.maxEmVoo mede a concorrência', async () => {
    const { pg, b } = await E.abrir();
    const pausa = E.segurarEnvios(b);
    const url = `${E.API}/imagens-material/empresa?nome=A`;
    const pendente = pg.janela.fetch(url, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: E.arquivo({ semente: 'q' }) });
    await pg.esperar();
    assert.equal(b.emVoo, 1);
    pausa.liberar();
    assert.equal((await pendente).status, 201);
    assert.deepEqual([b.emVoo, b.maxEmVoo], [0, 1]);
  });

  test('as URLs de objeto (prévias) são espiadas sem mudar o comportamento do Node', () => {
    const url = URL.createObjectURL(E.arquivo());
    assert.match(url, /^blob:/);
    URL.revokeObjectURL(url);
    assert.ok(E.objetosDeUrl.criados.includes(url));
    assert.ok(E.objetosDeUrl.revogados.includes(url));
  });
});

describe('5C-7 auxiliar — controles achados pelo nome acessível, não por classe', () => {
  const pagina = (corpo) => abrirPagina('pages/materials.html', { html: `<html><head></head><body><div id="modalImagemMaterial">${corpo}</div></body></html>` });

  test('nomeAcessivel ignora o ícone aria-hidden e prefere aria-label; botaoPorNome e abas() acham pelo nome', () => {
    const pg = pagina(`<button><span aria-hidden="true">add</span> Adicionar imagens</button>
      <button aria-pressed="true">Todas</button><button aria-pressed="false">Padrão SafeWork</button><button aria-pressed="false">Minha Empresa</button>
      <button aria-label="Tirar luva.png da lista">Tirar da lista</button>`);
    const m = E.modal(pg);
    assert.equal(E.nomeAcessivel(m.querySelectorAll('button')[0]), 'Adicionar imagens');
    assert.equal(E.nomeAcessivel(m.querySelectorAll('button')[4]), 'Tirar luva.png da lista');
    assert.ok(E.botaoAdicionar(pg));
    assert.deepEqual(E.abasAtivas(pg), ['Todas']);
    assert.ok(Object.values(E.abas(pg)).every(Boolean));
    assert.equal(E.botaoEnviar(pg), null);
    assert.throws(() => E.exigirBotao(E.modal(pg), /Voltar/, 'botão X'), /comportamento ausente: botão X/);
  });

  test('itemDoArquivo acha o item pelo botão cujo rótulo traz o nome do arquivo, com ou sem <li>, e o campo de nome dentro dele', () => {
    const pg = pagina(`<ul><li><input type="text" value="A"><span>Pronta</span><button aria-label="Tirar a.png da lista"></button></li>
      <li><span>Recusada</span><button aria-label="Tirar b.gif da lista"></button></li></ul>
      <div><div><input type="text" value="C"><button aria-label="Tirar c.png da lista"></button><span>Reaproveitada</span></div></div>`);
    const a = E.itemDoArquivo(pg, E.arquivo({ nome: 'a.png' }));
    assert.equal(a.nomeInput.value, 'A');
    assert.equal(E.textoDoItem(pg, E.arquivo({ nome: 'b.gif' })), 'Recusada');
    assert.equal(E.itemDoArquivo(pg, E.arquivo({ nome: 'b.gif' })).nomeInput, null);
    assert.match(E.textoDoItem(pg, E.arquivo({ nome: 'c.png' })), /Reaproveitada/);
    assert.throws(() => E.itemDoArquivo(pg, E.arquivo({ nome: 'z.png' })), /comportamento ausente: item do arquivo z.png/);
  });

  test('itemDoArquivo sem <li>: o item é o maior contêiner que tem só o botão de tirar DESTE arquivo; o campo de arquivos, as ações da vista e as outras linhas ficam de fora', () => {
    const umaLinha = pagina(`<div id="vista"><input type="file"><div id="lista"><div id="linha"><input type="text" value="X"><span>Erro da linha</span>
      <button aria-label="Tirar x.png da lista"></button></div></div><button>Voltar à biblioteca</button><button>Adicionar à biblioteca</button><span>Resumo geral</span></div>`);
    const { item, nomeInput } = E.itemDoArquivo(umaLinha, E.arquivo({ nome: 'x.png' }));
    assert.equal(nomeInput.value, 'X');
    assert.match(E.normalizarTexto(E.textoVisivel(item)), /Erro da linha/);
    assert.doesNotMatch(E.textoVisivel(item), /Resumo geral|Voltar/);
    const duas = pagina(`<div id="vista"><input type="file"><div id="lista"><div><span>Pronta A</span><input type="text" value="A"><button aria-label="Tirar a.png da lista"></button></div>
      <div><span>Recusada B</span><button aria-label="Tirar b.gif da lista"></button></div></div><button>Adicionar à biblioteca</button></div>`);
    assert.equal(E.textoDoItem(duas, E.arquivo({ nome: 'a.png' })), 'Pronta A');
    assert.equal(E.textoDoItem(duas, E.arquivo({ nome: 'b.gif' })), 'Recusada B');
    assert.equal(E.itemDoArquivo(duas, E.arquivo({ nome: 'b.gif' })).nomeInput, null);
  });
});

describe('5C-7 auxiliar — esperas, controles acionáveis e fábricas das páginas', () => {
  test('aguardar espera também o relógio real (o resumo SHA-256 não termina na fila de microtarefas)', async () => {
    const { pg } = await E.abrir();
    const inicio = Date.now();
    await E.aguardar(pg, 20);
    assert.ok(Date.now() - inicio >= 18, `esperou só ${Date.now() - inicio} ms`);
  });

  test('aguardarEnvios volta quando os envios simulados acabam e não trava com um envio segurado', async () => {
    const { pg, b } = await E.abrir();
    const url = (n) => `${E.API}/imagens-material/empresa?nome=${n}`;
    const enviar = (n) => pg.janela.fetch(url(n), { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: E.arquivo({ semente: `aguardar-${n}` }) });
    const tres = [enviar('A'), enviar('B'), enviar('C')];
    await E.aguardarEnvios(pg, b);
    assert.deepEqual([b.envios.length, b.emVoo], [3, 0]);
    assert.deepEqual((await Promise.all(tres)).map((r) => r.status), [201, 201, 201]);
    const pausa = E.segurarEnvios(b);
    const preso = enviar('D');
    const inicio = Date.now();
    await E.aguardarEnvios(pg, b);
    assert.ok(Date.now() - inicio < 3000, 'a espera deve encerrar com o envio ainda segurado');
    assert.equal(b.emVoo, 1);
    pausa.liberar();
    assert.equal((await preso).status, 201);
  });

  test('acionavel e naoVisivel: visível e habilitado × desabilitado, hidden e display:none (a regra de visibilidade é a do harness)', () => {
    const pg = abrirPagina('pages/materials.html', {
      html: `<html><head></head><body><div id="modalImagemMaterial"><button id="a">Um</button><button id="b" disabled>Dois</button><button id="c" hidden>Três</button>
        <button id="d" style="display:none">Quatro</button></div></body></html>`,
    });
    const [a, b, c, d] = ['a', 'b', 'c', 'd'].map((id) => pg.el(id));
    assert.deepEqual([a, b, c, d].map((x) => E.acionavel(pg, x)), [true, false, false, false]);
    assert.deepEqual([a, b, c, d].map((x) => E.naoVisivel(pg, x)), [false, false, true, true]);
    assert.equal(E.acionavel(pg, null), false);
    assert.equal(E.naoVisivel(pg, null), true);
    assert.deepEqual(E.nomesDosBotoes(E.modal(pg)), ['Um', 'Dois', 'Três', 'Quatro']);
  });

  test('empresaN gera n imagens ativas com ids sequenciais e sem repetição; criarBiblioteca as aceita', () => {
    const lista = E.empresaN(3);
    assert.deepEqual(lista.map((i) => i.id), ['7001', '7002', '7003']);
    assert.deepEqual(lista.map((i) => i.nome), ['Imagem da empresa 1', 'Imagem da empresa 2', 'Imagem da empresa 3']);
    assert.equal(E.empresaN(0).length, 0);
    const b = E.criarBiblioteca({ empresa: E.empresaN(2, 100, 'Outra') });
    assert.deepEqual(b.empresa.map((i) => [i.id, i.nome, i.estado]), [['100', 'Outra 1', 'ATIVA'], ['101', 'Outra 2', 'ATIVA']]);
  });

  test('normalizarTexto junta os espaços e apara; contagemTexto e estadoDoSeletor leem os elementos do seletor da 5B', async () => {
    assert.equal(E.normalizarTexto('  a \n  b\t c '), 'a b c');
    const { pg } = await E.abrir();
    await E.H.abrirSeletor(pg);
    assert.match(E.contagemTexto(pg), /^30 imagens$/);
    assert.equal(E.estadoDoSeletor(pg), '');
    assert.match(E.textoDoSeletor(pg), /Escolher imagem do material/);
  });
});
