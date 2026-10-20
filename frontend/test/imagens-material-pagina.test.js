'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/imagens-material');

/**
 * Unidade 5B-1 (RED) — o campo "Imagem do material" e o seletor da Biblioteca Padrão na página REAL pages/materials.html, no harness de DOM.
 * Descrevem o comportamento que a 5B-2 precisa entregar (seleção no formulário, sem persistência): a persistência em POST/PATCH e a leitura ao
 * reabrir o material são da 5B-3 e não são testadas aqui. Nada de PostgreSQL nem da API 3300: o `fetch` é simulado por rota com 30 imagens
 * fictícias. Cada teste abre pelo guarda "comportamento ausente", então hoje todos falham por a funcionalidade não existir, e nenhum por defeito
 * de infraestrutura. O contrato de DOM (ids) está em helpers/imagens-material.js. A caracterização do que já existe fica em
 * imagens-material-caracterizacao.test.js (nasce verde).
 */

const { IDS, API } = H;
const imagens = H.imagensPadrao();

/** Abre a página real e confirma que o campo existe (hoje: falha com "comportamento ausente"). */
async function abrirComCampo(opcoes) {
  const r = await H.abrir(opcoes);
  H.exigirCampo(r.pg);
  return r;
}

const previa = (pg) => pg.consulta(`#${IDS.previa} img`);
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
const fechar = async (pg) => { await pg.el(IDS.cancelar).disparar('click'); await pg.esperar(); };
const semImagem = (pg) => {
  assert.match(pg.texto(IDS.estado), /Nenhuma imagem selecionada/);
  assert.equal(previa(pg).length, 0, 'sem imagem não há <img> na prévia');
  assert.equal(pg.visivel(IDS.remover), false, '"Remover seleção" fica oculto');
};

// ─────────────────────────────────────────────────────────────────────
describe('5B — campo "Imagem do material": lugar no formulário', () => {
  test('o campo existe uma vez, com o rótulo "Imagem do material" e os controles de escolher e remover', async () => {
    const { pg } = await abrirComCampo();
    assert.equal(pg.consulta(`#${IDS.campo}`).length, 1);
    const campo = pg.el(IDS.campo);
    assert.match(campo.className, /\bfield\b/);
    assert.match(campo.className, /\bfull\b/);
    const rotulos = campo.querySelectorAll('label');
    assert.deepEqual(rotulos.map((l) => l.textContent.trim()), ['Imagem do material']);
    assert.equal(rotulos[0].getAttribute('for'), IDS.escolher);
    assert.match(pg.texto(IDS.escolher), /Escolher imagem/);
    assert.equal(pg.el(IDS.escolher).getAttribute('type'), 'button');
    assert.equal(pg.el(IDS.escolher).getAttribute('aria-haspopup'), 'dialog');
    assert.match(pg.texto(IDS.remover), /Remover seleção/);
    assert.equal(pg.el(IDS.remover).getAttribute('type'), 'button');
    for (const id of [IDS.previa, IDS.estado, IDS.escolher, IDS.remover]) assert.ok(campo.contains(pg.el(id)), `#${id} dentro do campo`);
  });

  test('fica logo depois da grade de tamanhos e antes de Fabricante e Código interno, sem mudar a ordem dos demais (HTML do arquivo)', () => {
    const ordem = H.ordemDoFormulario();
    const i = ordem.indexOf(IDS.campo);
    assert.notEqual(i, -1, 'comportamento ausente: o campo "Imagem do material" (#campoImagemMaterial) ainda não está no .form-grid de pages/materials.html');
    assert.equal(ordem[i - 1], 'campoGradeTamanhos', 'logo depois da grade de tamanhos');
    assert.equal(ordem[i + 1], 'materialFabricante', 'logo antes do Fabricante');
    assert.equal(ordem[i + 2], 'materialCodigo', 'e do Código interno');
    assert.deepEqual(ordem.filter((id) => id !== IDS.campo), [...H.ORDEM_ATUAL_DO_FORMULARIO]);
  });

  test('é visível com "Possui tamanhos", com "Tamanho único" e sem escolha, e não depende da grade nem da entrada inicial', async () => {
    const { pg } = await abrirComCampo();
    assert.equal(pg.visivel(IDS.campo), true, 'sem escolha de controle de tamanho');
    assert.equal(pg.el(IDS.campo).closest('#campoGradeTamanhos'), null);
    assert.equal(pg.el(IDS.campo).closest('#blocoEntradaInicial'), null);
    await H.digitarNoFormulario(pg, 'materialControleTamanho', 'grade', 'change');
    assert.equal(pg.visivel('campoGradeTamanhos'), true);
    assert.equal(pg.visivel(IDS.campo), true, 'com "Possui tamanhos"');
    await H.digitarNoFormulario(pg, 'materialControleTamanho', 'unico', 'change');
    assert.equal(pg.visivel('campoGradeTamanhos'), false);
    assert.equal(pg.visivel(IDS.campo), true, 'com "Tamanho único"');
  });

  test('material sem imagem: "Nenhuma imagem selecionada" (role=status), quadro sem <img> e "Remover seleção" oculto', async () => {
    const { pg } = await abrirComCampo();
    semImagem(pg);
    assert.equal(pg.el(IDS.estado).getAttribute('role'), 'status');
  });

  test('sem materials.criar nem materials.editar o botão fica desabilitado e nada abre nem consulta a biblioteca', async () => {
    const { pg } = await abrirComCampo({ p: H.permissoes({ materials: { visualizar: true, criar: false, editar: false, excluir: false } }) });
    assert.equal(pg.el(IDS.escolher).disabled, true);
    await pg.el(IDS.escolher).disparar('click');
    await pg.esperar();
    assert.equal(H.chamadasLista(pg).length, 0);
    if (pg.existe(IDS.modal)) assert.equal(pg.visivel(IDS.modal), false);
  });

  test('com materials.criar o botão fica habilitado', async () => {
    const { pg } = await abrirComCampo();
    assert.equal(pg.el(IDS.escolher).disabled, false);
  });

  test('só com materials.editar: desabilitado no cadastro, habilitado na edição e desabilitado de novo ao cancelar a edição', async () => {
    const { pg } = await abrirComCampo({ p: H.permissoes({ materials: { visualizar: true, criar: false, editar: true, excluir: false } }) });
    assert.equal(pg.el(IDS.escolher).disabled, true, 'no cadastro (sem materials.criar)');
    await H.entrarNaEdicao(pg);
    assert.equal(pg.el(IDS.escolher).disabled, false, 'na edição');
    await pg.clicar('botaoCancelarEdicao');
    assert.equal(pg.el(IDS.escolher).disabled, true, 'depois de cancelar a edição');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — seletor de imagens: abrir e fechar sem interferir no formulário', () => {
  test('nasce fechado; "Escolher imagem" o abre como diálogo modal, leva o foco para dentro e só consulta a biblioteca', async () => {
    const { pg } = await abrirComCampo();
    if (pg.existe(IDS.modal)) assert.equal(pg.visivel(IDS.modal), false, 'fechado ao carregar');
    const antes = pg.chamadas.length;
    await H.abrirSeletor(pg);
    assert.equal(pg.visivel(IDS.modal), true);
    const raiz = pg.el(IDS.modal);
    const dialogo = raiz.matches('[role="dialog"]') ? raiz : raiz.querySelector('[role="dialog"]');
    assert.ok(dialogo, 'o seletor precisa ter role="dialog"');
    assert.equal(dialogo.getAttribute('aria-modal'), 'true');
    const rotulado = dialogo.getAttribute('aria-labelledby');
    assert.ok(rotulado, 'aria-labelledby aponta para o título');
    assert.match(pg.texto(rotulado), /Escolher imagem do material/);
    assert.ok(raiz.contains(pg.documento.activeElement), 'o foco entra no seletor');
    assert.deepEqual(pg.chamadas.slice(antes).map((c) => c.chave), ['GET /imagens-material']);
    assert.match(pg.texto(IDS.confirmar), /Salvar imagem selecionada/);
    assert.match(pg.texto(IDS.cancelar), /Cancelar/);
    assert.equal(pg.el(IDS.fechar).getAttribute('aria-label'), 'Fechar');
    assert.equal(pg.el(IDS.busca).localName, 'input');
  });

  const fechamentos = [
    ['"Cancelar"', (pg) => pg.el(IDS.cancelar).disparar('click')],
    ['"×" (Fechar)', (pg) => pg.el(IDS.fechar).disparar('click')],
    ['a tecla Escape', (pg) => H.pressionar(pg.documento.activeElement ?? pg.el(IDS.lista), 'Escape')],
  ];
  for (const [rotulo, fecha] of fechamentos) {
    test(`fechar por ${rotulo}: some, devolve o foco a "Escolher imagem" e deixa o formulário e a escolha como estavam`, async () => {
      const { pg } = await abrirComCampo();
      await H.digitarNoFormulario(pg, 'materialNome', 'Botina nova');
      await H.digitarNoFormulario(pg, 'materialControleTamanho', 'grade', 'change');
      const antes = H.estadoDoFormulario(pg);
      await H.abrirSeletor(pg);
      await fecha(pg);
      await pg.esperar();
      assert.equal(pg.visivel(IDS.modal), false);
      assert.equal(pg.foco(), IDS.escolher);
      assert.deepEqual(H.estadoDoFormulario(pg), antes);
      semImagem(pg);
    });
  }

  test('Escape com o seletor fechado não faz nada: o foco, o formulário e a biblioteca ficam como estavam', async () => {
    const { pg } = await abrirComCampo();
    await H.digitarNoFormulario(pg, 'materialNome', 'Botina nova');
    pg.el('materialNome').focus();
    const antes = H.estadoDoFormulario(pg);
    await H.pressionar(pg.el('materialNome'), 'Escape');
    await pg.esperar();
    assert.equal(pg.foco(), 'materialNome');
    assert.deepEqual(H.estadoDoFormulario(pg), antes);
    assert.equal(H.chamadasLista(pg).length, 0);
  });

  test('abrir, fechar e abrir de novo não duplica as imagens do seletor', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    assert.equal(H.itens(pg).length, 30);
    await fechar(pg);
    await H.abrirSeletor(pg);
    assert.equal(H.itens(pg).length, 30);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — Biblioteca Padrão: listagem manual pelo contrato HTTP já existente', () => {
  test('uma única consulta GET /imagens-material (origem=TODAS desde a 5C-8a: as duas bibliotecas; pagina=1, limite=100), com cookie de sessão e sem tipo, busca ou outro filtro', async () => {
    const { pg } = await abrirComCampo();
    assert.equal(H.chamadasLista(pg).length, 0, 'nada é consultado antes de a pessoa pedir');
    await H.abrirSeletor(pg);
    const consultas = H.chamadasLista(pg);
    assert.equal(consultas.length, 1);
    const url = new URL(consultas[0].url);
    assert.equal(`${url.origin}${url.pathname}`, `${API}/imagens-material`);
    assert.deepEqual([...url.searchParams.keys()].sort(), ['limite', 'origem', 'pagina']);
    assert.equal(url.searchParams.get('origem'), 'TODAS');
    assert.equal(url.searchParams.get('pagina'), '1');
    assert.equal(url.searchParams.get('limite'), '100');
    assert.equal(consultas[0].credentials, 'include');
    assert.equal(consultas[0].corpoBruto, null);
  });

  test('mostra as 30 imagens na ordem da API, cada uma com o nome em texto, como opção de uma lista', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    const lis = H.itens(pg);
    assert.equal(lis.length, 30);
    assert.deepEqual(H.ids(lis), imagens.map((i) => i.id));
    lis.forEach((li, k) => {
      assert.equal(li.getAttribute('role'), 'option');
      assert.equal(li.getAttribute('data-imagem-origem'), 'PADRAO');
      assert.ok(li.textContent.includes(imagens[k].nome), imagens[k].nome);
    });
    assert.equal(pg.el(IDS.lista).getAttribute('role'), 'listbox');
    assert.match(pg.texto(IDS.contagem), /30/);
  });

  test('a pesquisa filtra no navegador, sem acento e sem diferenciar maiúsculas, e não faz nova consulta', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    const casos = [['oculos', 2], ['ÓCULOS', 2], ['LUVA', 3], ['  luva  ', 3], ['mascara', 1], ['raspa', 4]];
    for (const [termo, quantos] of casos) {
      await pg.digitar(IDS.busca, termo);
      await pg.esperar();
      const esperado = imagens.filter((i) => norm(i.nome).includes(norm(termo.trim()))).map((i) => i.id);
      assert.equal(esperado.length, quantos, `fixture: ${termo}`);
      assert.deepEqual(H.ids(H.itens(pg)), esperado, `pesquisa "${termo}"`);
    }
    await pg.digitar(IDS.busca, 'xyz');
    await pg.esperar();
    assert.equal(H.itens(pg).length, 0);
    assert.match(pg.texto(IDS.estadoModal), /nenhuma imagem/i);
    await pg.digitar(IDS.busca, '');
    await pg.esperar();
    assert.equal(H.itens(pg).length, 30);
    assert.equal(H.chamadasLista(pg).length, 1, 'a pesquisa é local');
  });

  test('enquanto a lista carrega mostra "carregando" e o botão de salvar fica desabilitado; depois mostra as imagens', async () => {
    const { espera, liberar } = H.segurar(H.listaOk(imagens));
    const { pg } = await abrirComCampo({ lista: () => espera });
    const clique = pg.el(IDS.escolher).disparar('click');
    await pg.esperar();
    H.exigirSeletor(pg);
    assert.equal(pg.visivel(IDS.modal), true);
    assert.match(pg.texto(IDS.estadoModal), /carreg/i);
    assert.equal(H.itens(pg).length, 0);
    assert.equal(pg.el(IDS.confirmar).disabled, true);
    liberar();
    await clique;
    await pg.esperar();
    assert.equal(H.itens(pg).length, 30);
    assert.doesNotMatch(pg.texto(IDS.estadoModal), /carreg/i);
  });

  const falhas = [
    ['403 (sem permissão)', () => H.erroApi(403, 'SEM_PERMISSAO'), /permiss/i],
    ['503 (armazenamento de imagens indisponível)', () => H.erroApi(503, 'IMAGENS_INDISPONIVEL'), /indispon/i],
    ['falha de rede', () => new Error('falha de rede simulada'), /rede|conex/i],
    ['500 (erro interno)', () => H.erroApi(500, 'ERRO_INTERNO'), /n[ãa]o foi poss[íi]vel|tente novamente/i],
  ];
  for (const [nome, lista, esperado] of falhas) {
    test(`falha da listagem — ${nome}: mensagem própria no seletor, sem texto do servidor, sem imagens, e o formulário segue utilizável`, async () => {
      const { pg } = await abrirComCampo({ lista });
      await H.digitarNoFormulario(pg, 'materialNome', 'Botina nova');
      await H.abrirSeletor(pg);
      const texto = pg.texto(IDS.estadoModal);
      assert.match(texto, esperado);
      assert.equal(pg.textoDoDom().includes(H.TEXTO_DO_SERVIDOR), false, 'o texto do servidor não aparece em lugar nenhum da tela');
      assert.equal(H.itens(pg).length, 0);
      assert.equal(pg.el(IDS.confirmar).disabled, true);
      await fechar(pg);
      assert.equal(pg.el('materialNome').value, 'Botina nova');
      assert.equal(pg.visivel('botaoSalvar'), true);
      semImagem(pg);
    });
  }

  test('depois de um erro, fechar e abrir de novo consulta outra vez', async () => {
    let n = 0;
    const { pg } = await abrirComCampo({ lista: () => { n += 1; return n === 1 ? H.erroApi(503, 'IMAGENS_INDISPONIVEL') : H.listaOk(imagens); } });
    await H.abrirSeletor(pg);
    assert.equal(H.itens(pg).length, 0);
    await fechar(pg);
    await H.abrirSeletor(pg);
    assert.equal(H.chamadasLista(pg).length, 2);
    assert.equal(H.itens(pg).length, 30);
  });

  test('biblioteca vazia: mensagem de estado vazio e nada para salvar', async () => {
    const { pg } = await abrirComCampo({ imagens: [] });
    await H.abrirSeletor(pg);
    assert.equal(H.itens(pg).length, 0);
    assert.match(pg.texto(IDS.estadoModal), /nenhuma imagem/i);
    assert.equal(pg.el(IDS.confirmar).disabled, true);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — miniaturas pela rota autenticada da API', () => {
  test('cada imagem mostra uma única miniatura cujo src é /imagens-material/padrao/<id>/miniatura?v=<versão>, inclusive o id acima de 2^53', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    H.itens(pg).forEach((li, k) => {
      const imgs = li.querySelectorAll('img');
      assert.equal(imgs.length, 1, imagens[k].nome);
      assert.equal(imgs[0].getAttribute('src'), H.urlMiniatura(imagens[k]));
      assert.ok(imgs[0].hasAttribute('alt'), 'toda <img> tem alt (vazio quando o nome já está no texto do item)');
    });
    const ultimo = H.itens(pg)[29];
    assert.equal(ultimo.getAttribute('data-imagem-id'), H.ID_GRANDE);
    assert.equal(ultimo.querySelector('img').getAttribute('src'), `${API}/imagens-material/padrao/${H.ID_GRANDE}/miniatura?v=3`);
  });

  test('só a rota autenticada da API fornece imagens: nada de data:, blob:, outra origem ou arquivo local, e nenhuma miniatura vai por fetch', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    const todas = pg.consulta(`#${IDS.modal} img`);
    assert.equal(todas.length, 30);
    for (const img of todas) assert.ok(img.getAttribute('src').startsWith(`${API}/imagens-material/padrao/`), img.getAttribute('src'));
    assert.equal(pg.chamadas.some((c) => /miniatura/.test(c.caminho)), false);
    assert.deepEqual(pg.externas, []);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — seleção explícita de uma imagem, sem associação automática', () => {
  test('ao abrir nada vem escolhido: nenhuma opção marcada, "Salvar imagem selecionada" desabilitado e o campo continua sem imagem', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    assert.equal(H.marcados(pg).length, 0);
    assert.equal(H.itens(pg).every((li) => li.getAttribute('aria-selected') === 'false'), true, 'toda opção declara aria-selected');
    assert.equal(pg.el(IDS.confirmar).disabled, true);
    semImagem(pg);
  });

  test('nome, grupo e controle de tamanho não escolhem nem reordenam imagens: nenhuma sugestão por tipo', async () => {
    const { pg } = await abrirComCampo();
    await H.digitarNoFormulario(pg, 'materialNome', 'Botina de Segurança');
    await H.digitarNoFormulario(pg, 'materialCategoria', 'EPI', 'change');
    await H.digitarNoFormulario(pg, 'materialControleTamanho', 'grade', 'change');
    await pg.esperar();
    await H.abrirSeletor(pg);
    assert.equal(H.marcados(pg).length, 0);
    assert.deepEqual(H.ids(H.itens(pg)), imagens.map((i) => i.id), 'a ordem é a da API, sem destaque por tipo');
    const url = new URL(H.chamadasLista(pg)[0].url);
    assert.equal(url.searchParams.has('tipoNome'), false);
    assert.equal(url.searchParams.has('busca'), false);
    assert.equal(pg.el(IDS.busca).value, '', 'o nome digitado no cadastro não vira pesquisa');
    semImagem(pg);
  });

  test('clicar numa imagem a marca (só ela), habilita "Salvar imagem selecionada" e ainda não muda o campo do formulário', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    await H.marcar(pg, 2);
    assert.deepEqual(H.ids(H.marcados(pg)), [imagens[2].id]);
    assert.equal(pg.el(IDS.confirmar).disabled, false);
    semImagem(pg);
  });

  test('clicar em outra imagem troca a marca: sempre uma só opção selecionada', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    await H.marcar(pg, 2);
    await H.marcar(pg, 7);
    assert.deepEqual(H.ids(H.marcados(pg)), [imagens[7].id]);
  });

  test('Enter e Espaço escolhem a opção focada; as setas, Home e End só movem o foco', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    const opcao = (k) => H.itens(pg)[k];
    const ativo = () => pg.documento.activeElement?.getAttribute('data-imagem-id') ?? null;
    opcao(0).focus();
    await H.pressionar(opcao(0), 'Enter');
    assert.deepEqual(H.ids(H.marcados(pg)), [imagens[0].id]);
    opcao(1).focus();
    await H.pressionar(opcao(1), ' ');
    assert.deepEqual(H.ids(H.marcados(pg)), [imagens[1].id]);
    await H.pressionar(pg.documento.activeElement, 'ArrowDown');
    assert.equal(ativo(), imagens[2].id);
    await H.pressionar(pg.documento.activeElement, 'End');
    assert.equal(ativo(), imagens[29].id);
    await H.pressionar(pg.documento.activeElement, 'Home');
    assert.equal(ativo(), imagens[0].id);
    assert.deepEqual(H.ids(H.marcados(pg)), [imagens[1].id], 'mover o foco não troca a escolha');
  });

  test('"Salvar imagem selecionada" fecha o seletor, mostra nome e miniatura no campo, habilita "Remover seleção" e devolve o foco', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    await H.marcar(pg, 2);
    await H.confirmar(pg);
    assert.equal(pg.visivel(IDS.modal), false);
    assert.ok(pg.texto(IDS.estado).includes(imagens[2].nome));
    assert.equal(previa(pg).length, 1);
    assert.equal(previa(pg)[0].getAttribute('src'), H.urlMiniatura(imagens[2]));
    assert.equal(pg.visivel(IDS.remover), true);
    assert.equal(pg.foco(), IDS.escolher);
  });

  test('"Cancelar" depois de marcar outra imagem mantém a escolha anterior do campo', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    await H.marcar(pg, 2);
    await H.confirmar(pg);
    await H.abrirSeletor(pg);
    await H.marcar(pg, 5);
    await fechar(pg);
    assert.ok(pg.texto(IDS.estado).includes(imagens[2].nome));
    assert.equal(previa(pg)[0].getAttribute('src'), H.urlMiniatura(imagens[2]));
  });

  test('"Remover seleção" volta ao estado sem imagem, devolve o foco e não tira nada da biblioteca', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    await H.marcar(pg, 2);
    await H.confirmar(pg);
    await pg.clicar(IDS.remover);
    semImagem(pg);
    assert.equal(pg.foco(), IDS.escolher);
    await H.abrirSeletor(pg);
    assert.equal(H.itens(pg).length, 30);
    assert.equal(H.marcados(pg).length, 0);
  });

  test('D5: escolher uma imagem não mexe no pictograma da 12G-7 do seletor de estoque', async () => {
    const { pg } = await abrirComCampo();
    pg.el('gradeMaterial').value = '501';
    await pg.el('gradeMaterial').disparar('change');
    await pg.esperar();
    const antes = pg.el('pictogramaMaterialAtual').children.length;
    assert.equal(pg.el('pictogramaMaterialAtual').hidden, false);
    await H.abrirSeletor(pg);
    await H.marcar(pg, 1);
    await H.confirmar(pg);
    const alvo = pg.el('pictogramaMaterialAtual');
    assert.equal(alvo.hidden, false);
    assert.equal(alvo.children.length, antes);
    assert.equal(alvo.querySelectorAll('img').length, 0, 'a imagem escolhida não substitui o pictograma');
  });

  test('nada é gravado: só GET, nenhum armazenamento do navegador e nenhum innerHTML em todo o caminho de escolher, confirmar e remover', async () => {
    const { pg } = await abrirComCampo();
    const inner = pg.documento.usosDeInnerHTML.length;
    const armazenamento = pg.storage.length;
    await H.abrirSeletor(pg);
    await H.marcar(pg, 4);
    await H.confirmar(pg);
    await H.abrirSeletor(pg);
    await H.marcar(pg, 6);
    await fechar(pg);
    await pg.clicar(IDS.remover);
    assert.deepEqual(pg.chamadas.filter((c) => c.metodo !== 'GET'), [], 'nenhuma escrita');
    assert.equal(pg.storage.length, armazenamento);
    assert.equal(pg.documento.usosDeInnerHTML.length, inner, JSON.stringify(pg.documento.usosDeInnerHTML.slice(inner)));
  });

  test('D4 adiada: o campo e o seletor não exibem a indicação "ilustrativa" nesta etapa', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    assert.equal(/ilustrativ/i.test(pg.texto(IDS.modal)), false);
    await H.marcar(pg, 2);
    await H.confirmar(pg);
    assert.equal(/ilustrativ/i.test(pg.texto(IDS.campo)), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — material sem imagem e imagem indisponível', () => {
  test('imagem escolhida cujo arquivo não carrega: o campo troca a miniatura por um quadro "Imagem indisponível" e a escolha continua registrada', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    await H.marcar(pg, 2);
    await H.confirmar(pg);
    assert.equal(previa(pg).length, 1);
    await H.falharImagem(previa(pg)[0]);
    await pg.esperar();
    assert.equal(previa(pg).length, 0, 'a miniatura quebrada sai da prévia');
    const rotulos = pg.el(IDS.previa).querySelectorAll('[aria-label]').map((e) => e.getAttribute('aria-label')).join(' ');
    assert.match(`${pg.texto(IDS.previa)} ${rotulos} ${pg.texto(IDS.estado)}`, /indispon/i);
    assert.ok(pg.texto(IDS.estado).includes(imagens[2].nome), 'o nome da escolha continua visível');
    assert.equal(pg.visivel(IDS.remover), true, 'dá para remover ou trocar');
  });

  test('miniatura que falha na lista não tira a imagem do seletor: continua com o nome e pode ser escolhida', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    await H.falharImagem(H.itens(pg)[3].querySelector('img'));
    await pg.esperar();
    assert.equal(H.itens(pg).length, 30);
    assert.ok(H.itens(pg)[3].textContent.includes(imagens[3].nome));
    await H.marcar(pg, 3);
    assert.deepEqual(H.ids(H.marcados(pg)), [imagens[3].id]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — construção segura do DOM (sem innerHTML)', () => {
  test('nomes com marcação aparecem como texto: nenhum elemento, atributo ou evento é criado a partir do nome', async () => {
    const lista = H.imagensPadrao({ hostil: true });
    const { pg } = await abrirComCampo({ imagens: lista });
    await H.abrirSeletor(pg);
    const item = H.itens(pg)[2];
    assert.equal(item.getAttribute('data-imagem-id'), lista[2].id);
    assert.ok(item.textContent.includes(H.NOME_HOSTIL), 'o nome aparece literal, como texto');
    assert.equal(pg.consulta(`#${IDS.modal} img`).length, 30, 'só as 30 miniaturas, nenhuma <img> injetada');
    assert.equal(pg.consulta(`#${IDS.modal} [onerror]`).length, 0);
    assert.equal(pg.consulta(`#${IDS.modal} b`).length, 0);
    await H.marcar(pg, 2);
    await H.confirmar(pg);
    assert.ok(pg.texto(IDS.estado).includes(H.NOME_HOSTIL));
    assert.equal(previa(pg).length, 1);
    assert.equal(previa(pg)[0].getAttribute('src'), H.urlMiniatura(lista[2]));
    assert.equal(pg.consulta(`#${IDS.campo} [onerror]`).length, 0);
    assert.equal(pg.consulta(`#${IDS.campo} b`).length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — a escolha do formulário não vaza para outros fluxos (sem persistência)', () => {
  test('"Limpar" desfaz a escolha da imagem junto com os demais campos', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    await H.marcar(pg, 2);
    await H.confirmar(pg);
    assert.equal(pg.visivel(IDS.remover), true);
    await pg.clicar('botaoLimpar');
    semImagem(pg);
  });

  test('entrar na edição de um material sem imagem não herda a escolha feita no cadastro', async () => {
    const { pg } = await abrirComCampo();
    await H.abrirSeletor(pg);
    await H.marcar(pg, 2);
    await H.confirmar(pg);
    await H.entrarNaEdicao(pg);
    semImagem(pg);
    await pg.clicar('botaoCancelarEdicao');
    semImagem(pg);
  });
});
