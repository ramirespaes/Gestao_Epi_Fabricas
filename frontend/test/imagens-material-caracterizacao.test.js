'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/imagens-material');

/**
 * Unidade 5B-1 — CARACTERIZAÇÃO do cadastro de materiais como ele é hoje. Estes testes nascem VERDES contra o estado atual de pages/materials.html e
 * precisam continuar verdes depois da integração do campo "Imagem do material" (5B-2 e 5B-3): são a prova de que o resto do cadastro não muda.
 * A única diferença aceita no HTML é o bloco #campoImagemMaterial, e nenhum corpo de POST ou PATCH muda enquanto nenhuma imagem for escolhida.
 * Roda a página real no harness de DOM, sem PostgreSQL e sem a API 3300.
 */

const { IDS } = H;

// ─────────────────────────────────────────────────────────────────────
describe('5B — caracterização: estrutura do formulário', () => {
  test('a ordem dos blocos do .form-grid é a de hoje (o campo de imagem, quando existir, é o único acréscimo)', () => {
    const ordem = H.ordemDoFormulario();
    assert.deepEqual(ordem.filter((id) => id !== IDS.campo), [...H.ORDEM_ATUAL_DO_FORMULARIO]);
    assert.ok(ordem.filter((id) => id === IDS.campo).length <= 1, 'o campo de imagem aparece no máximo uma vez');
  });

  test('o HTML do .form-grid, sem o bloco do campo de imagem, é o de hoje (atributos e textos)', () => {
    const atual = H.assinaturaDoFormulario();
    assert.equal(atual, H.ASSINATURA_ATUAL_DO_FORMULARIO, `o HTML do formulário mudou além do campo de imagem (assinatura atual ${atual})`);
  });

  test('o script da página tem as mesmas 22 atribuições a innerHTML de hoje', () => {
    assert.equal(H.contarInnerHtmlDoScript(), H.INNER_HTML_ATUAIS_NO_SCRIPT_DA_PAGINA);
  });

  test('a grade de tamanhos nasce oculta, aparece com "Possui tamanhos" e some com "Tamanho único"', async () => {
    const { pg } = await H.abrir();
    assert.equal(pg.visivel('campoGradeTamanhos'), false);
    await H.digitarNoFormulario(pg, 'materialControleTamanho', 'grade', 'change');
    assert.equal(pg.visivel('campoGradeTamanhos'), true);
    await H.digitarNoFormulario(pg, 'materialControleTamanho', 'unico', 'change');
    assert.equal(pg.visivel('campoGradeTamanhos'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — caracterização: a biblioteca de imagens só é consultada quando a pessoa pede', () => {
  test('ao carregar, a página faz as requisições de hoje e nenhuma à biblioteca de imagens', async () => {
    const { pg } = await H.abrir();
    // GET /suporte/notificacoes é a sondagem de fundo do menu (alertas do Suporte), não uma consulta da página.
    const daPagina = pg.chamadas.filter((c) => c.chave !== 'GET /suporte/notificacoes');
    assert.deepEqual(daPagina.map((c) => c.chave), ['GET /auth/me', 'GET /auth/global/me', 'GET /auth/permissoes', 'GET /materiais', 'GET /tipos-material']);
    assert.match(daPagina[3].url, /\/materiais\?ativo=true&pagina=1&limite=100$/);
    assert.match(daPagina[4].url, /\/tipos-material\?ativo=true&pagina=1&limite=5$/);
  });

  test('mexer em nome, grupo e controle de tamanho não consulta a biblioteca de imagens', async () => {
    const { pg } = await H.abrir();
    await H.digitarNoFormulario(pg, 'materialNome', 'Botina de Segurança');
    await H.digitarNoFormulario(pg, 'materialCategoria', 'Outros', 'change');
    await H.digitarNoFormulario(pg, 'materialControleTamanho', 'grade', 'change');
    await H.digitarNoFormulario(pg, 'materialControleTamanho', 'unico', 'change');
    await pg.esperar();
    assert.equal(pg.chamadas.filter((c) => /imagens-material/.test(c.caminho)).length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — caracterização: salvar sem escolher imagem envia exatamente o corpo de hoje', () => {
  const posts = (pg) => pg.chamadas.filter((c) => c.metodo === 'POST');
  const patches = (pg) => pg.chamadas.filter((c) => c.metodo === 'PATCH');

  test('cadastro de tamanho único: o POST /materiais leva os campos de hoje e nenhum campo de imagem', async () => {
    const { pg } = await H.abrir();
    await H.preencherCadastro(pg, { nome: 'Fita nova', controle: 'unico' });
    await pg.clicar('botaoSalvar');
    assert.equal(posts(pg).length, 1);
    assert.equal(posts(pg)[0].chave, 'POST /materiais');
    assert.deepEqual(posts(pg)[0].corpo, {
      nome: 'Fita nova', categoria: 'Outros', categoriaDescricao: 'Ferramenta', tipo: 'Outros', tipoDescricao: 'Fita isolante',
      fabricante: 'Fab X', unidade: 'unidade', prazoUsoDias: 180, exigeTamanho: false,
    });
    assert.match(H.avisoDaPagina(pg), /^Material cadastrado com sucesso\./);
  });

  test('cadastro com grade de tamanhos: o POST leva exigeTamanho e a grade, e nenhum campo de imagem', async () => {
    const { pg } = await H.abrir();
    await H.preencherCadastro(pg, { nome: 'Fita grade', controle: 'grade', grade: '38, 39' });
    await pg.clicar('botaoSalvar');
    assert.equal(posts(pg).length, 1);
    assert.deepEqual(posts(pg)[0].corpo, {
      nome: 'Fita grade', categoria: 'Outros', categoriaDescricao: 'Ferramenta', tipo: 'Outros', tipoDescricao: 'Fita isolante',
      fabricante: 'Fab X', unidade: 'unidade', prazoUsoDias: 180, exigeTamanho: true, tamanhos: ['38', '39'],
    });
  });

  test('edição sem mudar nada: nenhuma requisição PATCH e o aviso "Nenhuma alteração para salvar."', async () => {
    const { pg } = await H.abrir();
    await H.entrarNaEdicao(pg);
    await pg.clicar('botaoSalvar');
    assert.equal(patches(pg).length, 0);
    assert.equal(H.avisoDaPagina(pg), 'Nenhuma alteração para salvar.');
  });

  test('edição do nome: o PATCH leva só { nome } e nenhum campo de imagem', async () => {
    const { pg } = await H.abrir();
    await H.entrarNaEdicao(pg);
    await H.digitarNoFormulario(pg, 'materialNome', 'Fita isolante azul');
    await pg.clicar('botaoSalvar');
    assert.equal(patches(pg).length, 1);
    assert.equal(patches(pg)[0].chave, 'PATCH /materiais/501');
    assert.deepEqual(patches(pg)[0].corpo, { nome: 'Fita isolante azul' });
    assert.equal(H.avisoDaPagina(pg), 'Alterações do material salvas. O estoque não foi alterado.');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — caracterização: controle do verificador de padrões proibidos', () => {
  const exemplos = {
    dom: ['x.innerHTML = a', 'x.outerHTML = a', 'x.insertAdjacentHTML("beforeend", a)', 'document.write(a)', 'eval(a)', 'new Function("a")'],
    armazenamento: ['localStorage.getItem(a)', 'sessionStorage.setItem(a, b)', 'document.cookie = a', 'indexedDB.open(a)'],
    transporte: ['fetch(url)', 'new XMLHttpRequest()', 'navigator.sendBeacon(a)'],
  };
  const comuns = ['EpiHttp.requisitar("GET", caminho)', 'no.textContent = nome', 'fetchLista(a)', 'refetch(a)', 'cookieDoUsuario', 'evaluate(a)', 'novaFuncao'];

  test('cada padrão enxerga o seu uso proibido (controle positivo) e ignora texto comum (controle negativo)', () => {
    const grupos = [[H.PROIBIDOS_DE_DOM, exemplos.dom], [H.PROIBIDOS_DE_ARMAZENAMENTO, exemplos.armazenamento], [H.PROIBIDOS_DE_TRANSPORTE, exemplos.transporte]];
    for (const [padroes, usos] of grupos) {
      assert.equal(padroes.length, usos.length);
      padroes.forEach((padrao, k) => {
        assert.equal(padrao.test(usos[k]), true, `${padrao} deveria enxergar: ${usos[k]}`);
        for (const texto of comuns) assert.equal(padrao.test(texto), false, `${padrao} não deveria enxergar: ${texto}`);
      });
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B — caracterização: D5, o pictograma da 12G-7 no seletor de estoque', () => {
  test('sem material escolhido o pictograma fica oculto; com o material 501 aparece um desenho decorativo ao lado do nome', async () => {
    const { pg } = await H.abrir();
    assert.equal(pg.el('pictogramaMaterialAtual').hidden, true);
    pg.el('gradeMaterial').value = '501';
    await pg.el('gradeMaterial').disparar('change');
    await pg.esperar();
    const alvo = pg.el('pictogramaMaterialAtual');
    assert.equal(alvo.hidden, false);
    assert.equal(alvo.children.length, 1);
    assert.equal(alvo.getAttribute('aria-hidden'), 'true');
  });
});
