'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('./helpers/imagens-material-empresa');
const EpiMateriais = require('../js/materiais');

/**
 * Unidade 5C-7 (RED do frontend) — a BIBLIOTECA no seletor de imagens da página de materiais: as abas "Todas", "Padrão SafeWork" e "Minha Empresa" (rótulos do protótipo V6
 * aprovado), a listagem conjunta das duas bibliotecas, as miniaturas, a escolha por (origem, id), a associação ao material, o que fica gravado ao reabrir e o que acontece quando
 * a gravação é recusada. Roda a página real no harness de DOM sobre uma biblioteca simulada COM ESTADO (helpers/imagens-material-empresa.js), sem PostgreSQL, sem a API 3300 e
 * sem upload real. Os controles novos são achados pelo nome acessível, nunca por classe CSS. O que a página faz hoje com a Biblioteca Padrão (5B) está nos testes da 5B e não se
 * repete aqui; estes testes fixam o que a 5C-8 precisa acrescentar. Todo teste que depende de algo ainda inexistente falha com "comportamento ausente:"; os marcados
 * "(nasce verde)" protegem o que já funciona e não pode regredir quando a listagem conjunta entrar.
 */

const { H, P, MARCA } = E;
const { IDS } = H;
const { MSG } = EpiMateriais.mensagens;

const EMPRESA = [{ id: '5001', nome: 'Luva da empresa', versao: 1 }, { id: '5002', nome: 'Botina antiga da empresa', versao: 3 }];
const GRAVADA = { origem: 'EMPRESA', id: '5001', versao: 1, nome: 'Luva da empresa' };
const TEXTO_IMAGEM_AUSENTE = /A imagem escolhida não está mais disponível/;
const TEXTO_IMAGEM_RECUSADA = /O servidor não aceitou a imagem escolhida/;

/** A página real de materiais sobre uma biblioteca com `empresa`; os envios novos recebem ids a partir de 6001 (sem colidir com os fixos). */
const abrirCom = (empresa = EMPRESA, extra = {}) => E.abrir({ biblioteca: E.criarBiblioteca({ empresa, proximoId: 6001 }), ...extra });
const abrirSeletorComAbas = async (pg) => { await H.abrirSeletor(pg); E.exigirAbas(pg); };
const soComImagem = (resposta) => (c, padrao) => (Object.hasOwn(c.corpo ?? {}, 'imagem') ? resposta() : padrao(c));
const miniaturaDo = (no) => no.querySelector('img').getAttribute('src');
const doEmpresa = (lista) => lista.filter((p) => p.startsWith('EMPRESA:'));
const doPadrao = (lista) => lista.filter((p) => p.startsWith('PADRAO:'));
const itemPor = (pg, origem, id) => H.itens(pg).find((e) => E.par(e) === `${origem}:${id}`) ?? null;
const digitarBusca = async (pg, texto) => {
  pg.el(IDS.busca).value = texto;
  await pg.el(IDS.busca).disparar('input');
  await pg.esperar();
};

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 PB — abas e listagem das duas bibliotecas', () => {
  test('PB-01 o seletor tem as abas "Todas", "Padrão SafeWork" e "Minha Empresa" (botões com aria-pressed); ao abrir, só "Todas" está ativa', async () => {
    const { pg } = await abrirCom();
    await abrirSeletorComAbas(pg);
    assert.deepEqual(E.abasAtivas(pg), ['Todas']);
  });

  test('PB-02 ao abrir, UMA consulta traz as duas bibliotecas: GET /imagens-material?origem=TODAS&pagina=1&limite=100, com cookie de sessão, sem corpo e sem estado, busca nem empresa', async () => {
    const { pg } = await abrirCom();
    await abrirSeletorComAbas(pg);
    const chamadas = E.chamadasDaLista(pg);
    assert.equal(chamadas.length, 1);
    assert.deepEqual(E.consultaDaChamada(chamadas[0]), { origem: 'TODAS', pagina: '1', limite: '100' });
    assert.deepEqual([chamadas[0].metodo, chamadas[0].credentials, chamadas[0].corpoBruto], ['GET', 'include', null]);
  });

  test('PB-03 em "Todas": a Biblioteca Padrão primeiro e depois a da empresa, na ordem que o servidor mandou, sem repetir item, com a contagem total', async () => {
    const { pg } = await abrirCom();
    await abrirSeletorComAbas(pg);
    const lista = E.pares(pg);
    assert.equal(lista.length, 32);
    assert.equal(new Set(lista).size, 32);
    assert.deepEqual(doPadrao(lista), lista.slice(0, 30), 'as 30 padrão vêm antes');
    assert.deepEqual(lista.slice(30), ['EMPRESA:5002', 'EMPRESA:5001'], 'a ordem do servidor: nome da empresa em ordem alfabética');
    assert.match(E.contagemTexto(pg), /\b32 imagens\b/);
  });

  test('PB-04 as abas filtram NO CLIENTE (nenhuma consulta nova) e a contagem acompanha: Padrão SafeWork = 30, Minha Empresa = 2, Todas = 32', async () => {
    const { pg } = await abrirCom();
    await abrirSeletorComAbas(pg);
    await E.irParaAba(pg, 'Padrão SafeWork');
    assert.deepEqual(E.abasAtivas(pg), ['Padrão SafeWork']);
    assert.equal(E.pares(pg).length, 30);
    assert.equal(doEmpresa(E.pares(pg)).length, 0);
    assert.match(E.contagemTexto(pg), /\b30 imagens\b/);
    await E.irParaAba(pg, 'Minha Empresa');
    assert.deepEqual(E.abasAtivas(pg), ['Minha Empresa']);
    assert.deepEqual(E.pares(pg), ['EMPRESA:5002', 'EMPRESA:5001']);
    assert.match(E.contagemTexto(pg), /\b2 imagens\b/);
    await E.irParaAba(pg, 'Todas');
    assert.deepEqual(E.abasAtivas(pg), ['Todas']);
    assert.equal(E.pares(pg).length, 32);
    assert.equal(E.chamadasDaLista(pg).length, 1, 'trocar de aba não consulta o servidor de novo');
  });

  test('PB-05 cada miniatura usa a rota autenticada da SUA origem: /empresa/<id>/miniatura?v=<versão> para a da empresa e /padrao/<id>/miniatura?v=<versão> para a padrão', async () => {
    const { pg } = await abrirCom();
    await abrirSeletorComAbas(pg);
    const padrao = H.imagensPadrao();
    assert.equal(miniaturaDo(itemPor(pg, 'EMPRESA', '5001')), E.urlMiniaturaEmpresa({ id: '5001', versao: 1 }));
    assert.equal(miniaturaDo(itemPor(pg, 'EMPRESA', '5002')), `${E.API}/imagens-material/empresa/5002/miniatura?v=3`);
    assert.equal(miniaturaDo(itemPor(pg, 'PADRAO', padrao[4].id)), H.urlMiniatura(padrao[4]));
    for (const no of H.itens(pg)) {
      assert.equal(no.querySelectorAll('img').length, 1);
      assert.ok(no.querySelector('img').hasAttribute('alt'));
    }
  });

  test('PB-06 se a biblioteca passa de 100 itens, a seleção carrega TODAS as páginas (pagina=1, depois pagina=2) e mostra os 120 sem repetir nenhum', async () => {
    const { pg } = await abrirCom(E.empresaN(90));
    await abrirSeletorComAbas(pg);
    assert.deepEqual(E.chamadasDaLista(pg).map(E.consultaDaChamada), [{ origem: 'TODAS', pagina: '1', limite: '100' }, { origem: 'TODAS', pagina: '2', limite: '100' }]);
    const lista = E.pares(pg);
    assert.equal(lista.length, 120);
    assert.equal(new Set(lista).size, 120);
    assert.equal(doEmpresa(lista).length, 90);
    assert.match(E.contagemTexto(pg), /\b120 imagens\b/);
  });

  test('PB-07 imagem INATIVA da empresa nunca aparece na seleção (não pode ser associada: 404 no servidor) e a consulta não pede inativas', async () => {
    const { pg } = await abrirCom([...EMPRESA, { id: '5003', nome: 'Imagem inativa', versao: 1, estado: 'INATIVA' }]);
    await abrirSeletorComAbas(pg);
    assert.deepEqual(doEmpresa(E.pares(pg)).sort(), ['EMPRESA:5001', 'EMPRESA:5002']);
    for (const chamada of E.chamadasDaLista(pg)) assert.ok([undefined, 'ATIVA'].includes(E.consultaDaChamada(chamada).estado), 'o seletor só pede imagens ativas');
  });

  test('PB-08 a pesquisa vale nas duas bibliotecas, sem acento nem caixa, e é local: "luva" acha 3 padrão + a da empresa; "BOTÍNA" acha a padrão e a da empresa', async () => {
    const { pg } = await abrirCom();
    await abrirSeletorComAbas(pg);
    await digitarBusca(pg, 'luva');
    assert.equal(E.pares(pg).length, 4);
    assert.deepEqual(doEmpresa(E.pares(pg)), ['EMPRESA:5001']);
    assert.match(E.contagemTexto(pg), /Mostrando 4 de 32 imagens/);
    await digitarBusca(pg, 'BOTÍNA');
    assert.deepEqual(E.pares(pg).sort(), [...doPadrao(E.pares(pg)), 'EMPRESA:5002'].sort());
    assert.equal(doPadrao(E.pares(pg)).length, 1);
    await E.irParaAba(pg, 'Minha Empresa');
    assert.deepEqual(E.pares(pg), ['EMPRESA:5002'], 'a pesquisa continua valendo dentro da aba');
    assert.equal(E.chamadasDaLista(pg).length, 1, 'pesquisar não consulta o servidor');
  });

  test('PB-09 a aba "Minha Empresa" sem imagens diz que a empresa ainda não tem imagens (não que a Biblioteca Padrão está vazia) e oferece "Adicionar imagens"', async () => {
    const { pg } = await abrirCom([]);
    await abrirSeletorComAbas(pg);
    await E.irParaAba(pg, 'Minha Empresa');
    assert.equal(E.pares(pg).length, 0);
    assert.match(E.textoDoSeletor(pg), /ainda não tem imagens/i);
    assert.doesNotMatch(E.estadoDoSeletor(pg), /Biblioteca Padrão/);
    assert.equal(E.acionavel(pg, E.botaoAdicionar(pg)), true);
    await E.irParaAba(pg, 'Todas');
    assert.equal(E.pares(pg).length, 30, 'a aba "Todas" continua mostrando a Biblioteca Padrão');
  });

  test('PB-10 a falha de uma página SEGUINTE mantém o que já veio (a primeira página), avisa que a lista pode estar incompleta e uma nova abertura consulta de novo', async () => {
    const segundaPaginaFalha = (c, regra) => (new URL(c.url).searchParams.get('pagina') === '2' ? new Error('falha simulada') : regra(c));
    const { pg } = await abrirCom(E.empresaN(90), { respostas: { 'GET /imagens-material': segundaPaginaFalha } });
    await abrirSeletorComAbas(pg);
    assert.equal(E.pares(pg).length, 100, 'a primeira página inteira continua escolhível');
    assert.match(E.textoDoSeletor(pg), /incomplet|n[ãa]o foi poss[íi]vel carregar|tente novamente/i);
    assert.equal(pg.textoDoDom().includes(E.TEXTO_DO_SERVIDOR), false);
    const antes = E.chamadasDaLista(pg).length;
    await pg.clicar(IDS.fechar);
    await H.abrirSeletor(pg);
    assert.ok(E.chamadasDaLista(pg).length > antes, 'a lista incompleta não fica guardada como se fosse a biblioteca inteira');
  });

  test('PB-11 (nasce verde) a falha da PRIMEIRA página é a falha do seletor: nenhuma imagem, texto próprio, e o formulário do material segue utilizável (o caminho passa a ser o de várias páginas)', async () => {
    const { pg } = await abrirCom(EMPRESA, { respostas: { 'GET /imagens-material': () => P.erroDe(503, 'IMAGENS_INDISPONIVEL', E.TEXTO_DO_SERVIDOR) } });
    await H.digitarNoFormulario(pg, 'materialNome', 'Botina nova');
    await H.abrirSeletor(pg);
    assert.equal(E.pares(pg).length, 0);
    assert.match(E.estadoDoSeletor(pg), /indispon/i);
    assert.equal(pg.textoDoDom().includes(E.TEXTO_DO_SERVIDOR), false);
    await pg.clicar(IDS.cancelar);
    assert.equal(pg.el('materialNome').value, 'Botina nova');
  });

  test('PB-12 (nasce verde) nada vem escolhido sozinho: com imagens da empresa na lista, ao abrir não há item marcado e "Salvar imagem selecionada" fica desabilitado', async () => {
    const { pg } = await abrirCom();
    await H.abrirSeletor(pg);
    assert.deepEqual(E.paresMarcados(pg), []);
    assert.equal(pg.el(IDS.confirmar).disabled, true);
    assert.match(pg.texto(IDS.estado), /Nenhuma imagem selecionada/);
  });

  test('PB-13 (nasce verde) 401 na listagem encerra a sessão como em qualquer outra consulta da página (o caminho passa a ser o de várias páginas)', async () => {
    const { pg } = await abrirCom(EMPRESA, { respostas: { 'GET /imagens-material': () => P.erroDe(401, 'NAO_AUTENTICADO', E.TEXTO_DO_SERVIDOR) } });
    await H.abrirSeletor(pg);
    assert.ok(pg.navegacoes.some((n) => /portal\//.test(n)), `a pessoa volta ao Portal do Cliente (${JSON.stringify(pg.navegacoes)})`);
    assert.equal(pg.textoDoDom().includes(E.TEXTO_DO_SERVIDOR), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 PB — escolha por (origem, id): o mesmo número em bibliotecas diferentes não é a mesma imagem', () => {
  const COLISAO = [{ id: '1001', nome: 'Luva da empresa', versao: 1 }];

  test('PB-14 EMPRESA:1001 e PADRAO:1001 coexistem: marcar a da empresa marca SÓ ela, a marca não passa para a padrão ao trocar de aba, e confirmar grava a da empresa', async () => {
    const { pg } = await abrirCom(COLISAO);
    await abrirSeletorComAbas(pg);
    assert.ok(itemPor(pg, 'PADRAO', '1001') && itemPor(pg, 'EMPRESA', '1001'), `${MARCA} as duas imagens de id 1001 na mesma lista`);
    await itemPor(pg, 'EMPRESA', '1001').disparar('click');
    assert.deepEqual(E.paresMarcados(pg), ['EMPRESA:1001']);
    await E.irParaAba(pg, 'Padrão SafeWork');
    assert.deepEqual(E.paresMarcados(pg), [], 'a padrão de mesmo número não herda a marca');
    await E.irParaAba(pg, 'Todas');
    assert.deepEqual(E.paresMarcados(pg), ['EMPRESA:1001']);
    await H.confirmar(pg);
    assert.ok(pg.texto(IDS.estado).includes('Luva da empresa'));
    assert.equal(pg.consulta(`#${IDS.previa} img`)[0].getAttribute('src'), E.urlMiniaturaEmpresa({ id: '1001', versao: 1 }));
    await H.abrirSeletor(pg);
    assert.deepEqual(E.paresMarcados(pg), ['EMPRESA:1001'], 'ao reabrir, a imagem atual do campo é a da empresa');
  });

  test('PB-15 o inverso: marcar PADRAO:1001 não marca a EMPRESA:1001, e depois de gravada a da empresa a escolha da padrão a substitui no campo', async () => {
    const { pg } = await abrirCom(COLISAO);
    await abrirSeletorComAbas(pg);
    await itemPor(pg, 'PADRAO', '1001').disparar('click');
    assert.deepEqual(E.paresMarcados(pg), ['PADRAO:1001']);
    await H.confirmar(pg);
    assert.equal(pg.consulta(`#${IDS.previa} img`)[0].getAttribute('src'), H.urlMiniatura(H.imagensPadrao()[0]));
    await H.abrirSeletor(pg);
    assert.deepEqual(E.paresMarcados(pg), ['PADRAO:1001']);
    await itemPor(pg, 'EMPRESA', '1001').disparar('click');
    assert.deepEqual(E.paresMarcados(pg), ['EMPRESA:1001'], 'uma só marca por vez, e é a da empresa');
    assert.equal(pg.el(IDS.confirmar).disabled, false, 'trocar de origem com o mesmo número é uma mudança de verdade');
  });

  test('PB-16 o resumo da seleção diz qual imagem e de qual biblioteca: "Selecionada: <nome> (Minha Empresa)" ou "(Padrão SafeWork)"', async () => {
    const { pg } = await abrirCom();
    await abrirSeletorComAbas(pg);
    await itemPor(pg, 'EMPRESA', '5001').disparar('click');
    assert.match(E.resumoDaSelecao(pg), /Selecionada:\s*Luva da empresa.*Minha Empresa/);
    const nitrilica = H.imagensPadrao().find((i) => i.nome === 'Luva Nitrílica');
    await itemPor(pg, 'PADRAO', nitrilica.id).disparar('click');
    assert.match(E.resumoDaSelecao(pg), /Selecionada:\s*Luva Nitrílica.*Padrão SafeWork/);
    assert.equal(E.paresMarcados(pg).length, 1);
  });

  test('PB-17 pelo teclado: Enter e Espaço escolhem a imagem da empresa como escolhem a padrão, e as setas passam de uma biblioteca para a outra na ordem da lista', async () => {
    const { pg } = await abrirCom();
    await abrirSeletorComAbas(pg);
    const ultimaPadrao = H.itens(pg)[29];
    await H.pressionar(ultimaPadrao, 'ArrowDown');
    assert.equal(pg.documento.activeElement && E.par(pg.documento.activeElement), 'EMPRESA:5002', 'a seta para baixo vai da última padrão à primeira da empresa');
    await H.pressionar(pg.documento.activeElement, 'Enter');
    assert.deepEqual(E.paresMarcados(pg), ['EMPRESA:5002']);
    await H.pressionar(pg.documento.activeElement, 'ArrowDown');
    await H.pressionar(pg.documento.activeElement, ' ');
    assert.deepEqual(E.paresMarcados(pg), ['EMPRESA:5001']);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 PB — associar a imagem da empresa ao material e recuperá-la', () => {
  test('PB-18 escolher a imagem da empresa: o campo mostra nome e miniatura da empresa, avisa que será gravada ao salvar e oferece "Remover seleção"; nada é gravado ainda', async () => {
    const { pg } = await abrirCom();
    await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
    const estado = pg.texto(IDS.estado);
    assert.ok(estado.includes('Luva da empresa'));
    assert.match(estado, /será gravada ao salvar o material/i);
    const miniaturas = pg.consulta(`#${IDS.previa} img`);
    assert.equal(miniaturas.length, 1);
    assert.equal(miniaturas[0].getAttribute('src'), E.urlMiniaturaEmpresa({ id: '5001', versao: 1 }));
    assert.equal(pg.visivel(IDS.remover), true);
    assert.equal(P.escritas(pg).length, 0);
  });

  test('PB-19 cadastro: o POST leva imagem { origem: "EMPRESA", id } (só essas duas chaves, id em texto) e o resto do corpo é o de sempre; o schema REAL do backend aceita; o campo volta vazio', async () => {
    const { pg, b } = await abrirCom();
    await H.preencherCadastro(pg, { nome: 'Fita nova' });
    await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
    await pg.clicar('botaoSalvar');
    assert.equal(P.posts(pg).length, 1);
    const corpo = P.posts(pg)[0].corpo;
    assert.deepEqual(corpo, { ...P.CORPO_TAMANHO_UNICO('Fita nova'), imagem: { origem: 'EMPRESA', id: '5001' } });
    assert.deepEqual(Object.keys(corpo.imagem).sort(), ['id', 'origem']);
    P.aceitoPeloBackend('criar', corpo);
    assert.match(H.avisoDaPagina(pg), /^Material cadastrado com sucesso\./);
    assert.deepEqual([b.materiais.get(999).imagem.origem, b.materiais.get(999).imagem.id], ['EMPRESA', '5001']);
    P.semImagem(pg);
  });

  test('PB-20 imagem da empresa com id acima de 2^53: o texto exato chega ao servidor, sem passar por Number, e o schema do backend o preserva', async () => {
    const { pg } = await abrirCom([{ id: E.ID_GRANDE_EMPRESA, nome: 'Imagem grande', versao: 1 }]);
    await H.preencherCadastro(pg, { nome: 'Fita grande' });
    await E.escolherNoSeletor(pg, 'EMPRESA', E.ID_GRANDE_EMPRESA);
    await pg.clicar('botaoSalvar');
    const [chamada] = P.posts(pg);
    assert.equal(chamada.corpo.imagem.id, E.ID_GRANDE_EMPRESA);
    assert.ok(chamada.corpoBruto.includes(`"id":"${E.ID_GRANDE_EMPRESA}"`), chamada.corpoBruto);
    assert.equal(P.aceitoPeloBackend('criar', chamada.corpo).imagem.id, E.ID_GRANDE_EMPRESA);
  });

  test('PB-21 edição de material que JÁ tem imagem da empresa: o campo a mostra (nome, miniatura com a versão, "gravada neste material"); sem mudar nada não há PATCH', async () => {
    const { pg } = await abrirCom(EMPRESA, { imagemInicial: GRAVADA });
    await H.entrarNaEdicao(pg);
    const estado = pg.texto(IDS.estado);
    assert.ok(estado.includes('Luva da empresa'), `${MARCA} o campo deveria mostrar a imagem da empresa gravada (mostrou: ${estado})`);
    assert.match(estado, /gravada neste material/i);
    assert.equal(pg.consulta(`#${IDS.previa} img`)[0].getAttribute('src'), E.urlMiniaturaEmpresa(GRAVADA));
    assert.equal(pg.visivel(IDS.remover), true);
    await pg.clicar('botaoSalvar');
    assert.equal(P.escritas(pg).length, 0);
    assert.equal(H.avisoDaPagina(pg), MSG.EDICAO_SEM_ALTERACAO);
  });

  test('PB-22 trocar a imagem da empresa por OUTRA da empresa: o PATCH leva só { imagem: { origem: "EMPRESA", id } }', async () => {
    const { pg, b } = await abrirCom(EMPRESA, { imagemInicial: GRAVADA });
    await H.entrarNaEdicao(pg);
    await E.escolherNoSeletor(pg, 'EMPRESA', '5002');
    assert.match(pg.texto(IDS.estado), /será gravada ao salvar o material/i);
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => [c.chave, c.corpo]), [['PATCH /materiais/501', { imagem: { origem: 'EMPRESA', id: '5002' } }]]);
    P.aceitoPeloBackend('alterar', P.patches(pg)[0].corpo);
    assert.equal(b.materiais.get(501).imagem.id, '5002');
  });

  test('PB-23 trocar a imagem da empresa por uma da Biblioteca Padrão: o PATCH leva { origem: "PADRAO", id }', async () => {
    const { pg, b } = await abrirCom(EMPRESA, { imagemInicial: GRAVADA });
    await H.entrarNaEdicao(pg);
    assert.ok(pg.texto(IDS.estado).includes('Luva da empresa'), `${MARCA} o campo deveria mostrar a imagem da empresa gravada antes da troca`);
    await E.escolherNoSeletor(pg, 'PADRAO', '1003');
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => c.corpo), [{ imagem: { origem: 'PADRAO', id: '1003' } }]);
    assert.equal(b.materiais.get(501).imagem.origem, 'PADRAO');
  });

  test('PB-24 trocar a imagem da Biblioteca Padrão por uma da empresa: o PATCH leva { origem: "EMPRESA", id }', async () => {
    const { pg, b } = await abrirCom(EMPRESA, { imagemInicial: P.registro(P.IMAGENS[2]) });
    await H.entrarNaEdicao(pg);
    await H.abrirSeletor(pg);
    E.exigirAbas(pg);
    assert.deepEqual(E.paresMarcados(pg), ['PADRAO:1003'], 'a imagem gravada abre marcada');
    await itemPor(pg, 'EMPRESA', '5001').disparar('click');
    await H.confirmar(pg);
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => c.corpo), [{ imagem: { origem: 'EMPRESA', id: '5001' } }]);
    assert.equal(b.materiais.get(501).imagem.origem, 'EMPRESA');
  });

  test('PB-25 remover a imagem da empresa gravada: o campo avisa que será removida e o PATCH leva { imagem: null }; a imagem continua na biblioteca da empresa', async () => {
    const { pg, b } = await abrirCom(EMPRESA, { imagemInicial: GRAVADA });
    await H.entrarNaEdicao(pg);
    assert.ok(pg.texto(IDS.estado).includes('Luva da empresa'), `${MARCA} o campo deveria mostrar a imagem da empresa gravada`);
    await pg.clicar(IDS.remover);
    assert.match(pg.texto(IDS.estado), /Nenhuma imagem selecionada/);
    assert.match(pg.texto(IDS.estado), /será removida ao salvar o material/i);
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => c.corpo), [{ imagem: null }]);
    assert.equal(b.materiais.get(501).imagem, null);
    assert.ok(b.acharEmpresa('5001'), 'remover a associação não apaga a imagem da biblioteca');
  });

  test('PB-26 a MESMA imagem da empresa em vários materiais: dois PATCH com o mesmo { origem, id }, e o servidor conta dois usos', async () => {
    const outro = { ...H.MATERIAL, id: 502, nome: 'Fita autofusão' };
    const { pg, b } = await abrirCom(EMPRESA, { outros: [outro] });
    await H.entrarNaEdicao(pg);
    await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
    await pg.clicar('botaoSalvar');
    await P.entrarNaEdicaoDe(pg, 502);
    await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => [c.chave, c.corpo]), [
      ['PATCH /materiais/501', { imagem: { origem: 'EMPRESA', id: '5001' } }], ['PATCH /materiais/502', { imagem: { origem: 'EMPRESA', id: '5001' } }]]);
    assert.equal(b.usos('EMPRESA', '5001'), 2);
  });

  test('PB-27 depois de salvar, reabrir o material lê o que o servidor gravou: a imagem da empresa aparece como "gravada neste material" e nenhum segundo PATCH sai', async () => {
    const { pg } = await abrirCom();
    await H.entrarNaEdicao(pg);
    await E.escolherNoSeletor(pg, 'EMPRESA', '5002');
    await pg.clicar('botaoSalvar');
    assert.equal(P.patches(pg).length, 1);
    P.semImagem(pg);
    await H.entrarNaEdicao(pg);
    assert.ok(pg.texto(IDS.estado).includes('Botina antiga da empresa'), `${MARCA} reabrir deveria mostrar a imagem da empresa gravada`);
    assert.match(pg.texto(IDS.estado), /gravada neste material/i);
    assert.equal(pg.consulta(`#${IDS.previa} img`)[0].getAttribute('src'), `${E.API}/imagens-material/empresa/5002/miniatura?v=3`);
    await pg.clicar('botaoSalvar');
    assert.equal(P.patches(pg).length, 1);
  });

  test('PB-28 cadastro com imagem da empresa: abrir o material recém-criado mostra a imagem gravada', async () => {
    const { pg, b } = await abrirCom();
    await H.preencherCadastro(pg, { nome: 'Fita nova' });
    await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
    await pg.clicar('botaoSalvar');
    assert.equal(b.materiais.get(999).imagem.id, '5001');
    await P.entrarNaEdicaoDe(pg, 999);
    assert.match(pg.texto('modoEdicao'), /Editando: Fita nova/);
    assert.ok(pg.texto(IDS.estado).includes('Luva da empresa'), `${MARCA} o campo deveria mostrar a imagem da empresa gravada`);
  });

  test('PB-29 escolher e remover antes de salvar: o POST não leva a chave imagem; e cancelar a edição descarta a escolha da empresa (sem vazar para o cadastro seguinte)', async () => {
    const { pg } = await abrirCom();
    await H.preencherCadastro(pg, { nome: 'Fita sem' });
    await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
    await pg.clicar(IDS.remover);
    P.semImagem(pg);
    await pg.clicar('botaoSalvar');
    assert.equal(Object.hasOwn(P.posts(pg)[0].corpo, 'imagem'), false);
    await H.entrarNaEdicao(pg);
    await E.escolherNoSeletor(pg, 'EMPRESA', '5002');
    await pg.clicar('botaoCancelarEdicao');
    P.semImagem(pg);
    await H.preencherCadastro(pg, { nome: 'Depois do cancelamento' });
    await pg.clicar('botaoSalvar');
    assert.equal(Object.hasOwn(P.posts(pg)[1].corpo, 'imagem'), false);
  });

  test('PB-30 o seletor só guarda a escolha quando a pessoa confirma: cancelar, fechar e Escape deixam o campo como estava, também com imagem da empresa', async () => {
    const { pg } = await abrirCom(EMPRESA, { imagemInicial: GRAVADA });
    await H.entrarNaEdicao(pg);
    assert.ok(pg.texto(IDS.estado).includes('Luva da empresa'), `${MARCA} o campo deveria mostrar a imagem da empresa gravada`);
    for (const sair of [IDS.cancelar, IDS.fechar]) {
      await H.abrirSeletor(pg);
      await itemPor(pg, 'EMPRESA', '5002').disparar('click');
      await pg.clicar(sair);
      assert.ok(pg.texto(IDS.estado).includes('Luva da empresa'), `depois de ${sair} o campo continua com a imagem gravada`);
    }
    await H.abrirSeletor(pg);
    await itemPor(pg, 'EMPRESA', '5002').disparar('click');
    await H.pressionar(pg.el(IDS.busca), 'Escape');
    await pg.esperar();
    assert.equal(pg.el(IDS.modal).getAttribute('aria-hidden'), 'true', 'Escape fecha o seletor');
    assert.ok(pg.texto(IDS.estado).includes('Luva da empresa'));
    assert.equal(P.escritas(pg).length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 PB — quando a gravação com imagem da empresa é recusada: texto próprio, formulário e escolha preservados, nada repetido sozinho', () => {
  test('PB-31 a imagem foi inativada por outra pessoa antes de salvar (404 IMAGEM_NAO_ENCONTRADA): texto próprio que não fala da Biblioteca Padrão, uma tentativa só, formulário e escolha preservados; sem a imagem o mesmo cadastro passa', async () => {
    const { pg, b } = await abrirCom();
    await H.preencherCadastro(pg, { nome: 'Fita nova' });
    await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
    b.acharEmpresa('5001').estado = 'INATIVA';
    await pg.clicar('botaoSalvar');
    const aviso = H.avisoDaPagina(pg);
    assert.match(aviso, TEXTO_IMAGEM_AUSENTE);
    assert.doesNotMatch(aviso, /Biblioteca Padrão|Material não encontrado|Não foi possível cadastrar/);
    assert.equal(P.posts(pg).length, 1);
    await pg.avancar();
    assert.equal(P.posts(pg).length, 1, 'nenhum temporizador repete o cadastro sozinho');
    assert.equal(pg.el('materialNome').value, 'Fita nova');
    assert.ok(pg.texto(IDS.estado).includes('Luva da empresa'), 'a escolha continua registrada');
    assert.match(pg.texto(IDS.estado), /será gravada/i);
    await pg.clicar(IDS.remover);
    await pg.clicar('botaoSalvar');
    assert.equal(P.posts(pg).length, 2);
    assert.equal(Object.hasOwn(P.posts(pg)[1].corpo, 'imagem'), false);
    assert.match(H.avisoDaPagina(pg), /^Material cadastrado com sucesso\./);
  });

  test('PB-32 edição: a imagem da empresa que o PATCH recusa (404 IMAGEM_NAO_ENCONTRADA) tem texto próprio, uma tentativa só, e a escolha pendente fica no campo', async () => {
    const { pg } = await abrirCom(EMPRESA, { respostas: { 'PATCH /materiais/501': soComImagem(P.ERRO_IMAGEM_NAO_ENCONTRADA) } });
    await H.entrarNaEdicao(pg);
    await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
    await pg.clicar('botaoSalvar');
    assert.match(H.avisoDaPagina(pg), TEXTO_IMAGEM_AUSENTE);
    assert.doesNotMatch(H.avisoDaPagina(pg), /Biblioteca Padrão|Material não encontrado/);
    assert.equal(P.patches(pg).length, 1);
    assert.ok(pg.texto(IDS.estado).includes('Luva da empresa'));
    assert.match(pg.texto(IDS.estado), /será gravada/i);
  });

  test('PB-33 400 com o detalhe em body.imagem: "O servidor não aceitou a imagem escolhida", sem o texto do servidor, escolha e formulário preservados', async () => {
    const recusada = () => P.erro400('body.imagem.id', 'ID_INVALIDO', E.TEXTO_DO_SERVIDOR);
    const { pg } = await abrirCom(EMPRESA, { respostas: { 'POST /materiais': soComImagem(recusada) } });
    await H.preencherCadastro(pg, { nome: 'Fita nova' });
    await E.escolherNoSeletor(pg, 'EMPRESA', '5002');
    await pg.clicar('botaoSalvar');
    assert.match(H.avisoDaPagina(pg), TEXTO_IMAGEM_RECUSADA);
    assert.equal(pg.textoDoDom().includes(E.TEXTO_DO_SERVIDOR), false);
    assert.equal(P.posts(pg).length, 1);
    assert.equal(pg.el('materialNome').value, 'Fita nova');
    assert.ok(pg.texto(IDS.estado).includes('Botina antiga da empresa'));
  });

  const INCONCLUSIVOS = [
    ['falha de rede', () => new TypeError('Failed to fetch')],
    ['erro 500', () => P.erroDe(500, 'ERRO_INTERNO', 'x')],
    ['erro 503', () => P.erroDe(503, 'SERVICO_INDISPONIVEL', 'x')],
    ['resposta que não é JSON', () => ({ status: 200, texto: '<html>proxy</html>' })],
  ];
  for (const [rotulo, resposta] of INCONCLUSIVOS) {
    test(`PB-34 ${rotulo} ao gravar com imagem da empresa: o cadastro pode ter acontecido, então aviso de atenção, formulário e escolha preservados, uma tentativa só e nenhuma repetição automática`, async () => {
      const { pg } = await abrirCom(EMPRESA, { respostas: { 'POST /materiais': soComImagem(resposta) } });
      await H.preencherCadastro(pg, { nome: 'Fita nova' });
      await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
      await pg.clicar('botaoSalvar');
      assert.doesNotMatch(H.avisoDaPagina(pg), /^Material cadastrado com sucesso/);
      assert.ok(H.avisoDaPagina(pg).length > 0);
      assert.equal(P.posts(pg).length, 1);
      await pg.avancar();
      assert.equal(P.posts(pg).length, 1);
      assert.equal(pg.el('materialNome').value, 'Fita nova');
      assert.ok(pg.texto(IDS.estado).includes('Luva da empresa'));
      assert.match(pg.texto(IDS.estado), /será gravada/i);
    });
  }

  test('PB-35 sessão encerrada (401) ao gravar com imagem da empresa: o tratamento de sempre, devolvendo ao Portal, e nenhuma segunda escrita', async () => {
    for (const rota of ['POST /materiais', 'PATCH /materiais/501']) {
      const emEdicao = rota.startsWith('PATCH');
      const { pg } = await abrirCom(EMPRESA, { respostas: { [rota]: () => P.erroDe(401, 'NAO_AUTENTICADO', 'x') } });
      if (emEdicao) await H.entrarNaEdicao(pg); else await H.preencherCadastro(pg, { nome: 'Fita nova' });
      await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
      await pg.clicar('botaoSalvar');
      assert.ok(pg.navegacoes.some((n) => /portal\//.test(n)), `${rota}: volta ao Portal (${JSON.stringify(pg.navegacoes)})`);
      assert.equal(P.escritas(pg).length, 1, rota);
    }
  });
});
