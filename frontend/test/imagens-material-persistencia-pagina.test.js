'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const H = require('./helpers/imagens-material');
const P = require('./helpers/imagens-material-persistencia');
const EpiMateriais = require('../js/materiais');

/**
 * Unidade 5B-3 — PERSISTÊNCIA da imagem no cadastro de materiais. Roda a página real no harness de DOM sobre uma API de materiais com estado que segue o
 * contrato lido no backend local (helpers/imagens-material-persistencia.js), e confere o corpo gerado também contra o schema REAL do backend.
 *
 * Regras fixadas: `imagem` só vai quando há mudança — `{ origem, id }` (exatamente essas duas chaves, id em texto) para associar ou trocar, `null` para
 * remover; ausente quando nada mudou; o cadastro sem escolha continua com o corpo de sempre. Reabrir lê `material.imagem` do servidor. Nada vaza entre
 * cadastro, edições e materiais. A recusa da imagem tem texto próprio e nunca vira "Material não encontrado". Nada é repetido sozinho.
 * Os testes marcados "(nasce verde)" protegem comportamento que já existe e não pode regredir quando a persistência entrar.
 */

const { IDS } = H;
const imagens = P.IMAGENS;
const reg = (i) => P.registro(imagens[i]);
const { MSG } = EpiMateriais.mensagens;

const TEXTO_IMAGEM_AUSENTE = /A imagem escolhida não está mais disponível/;
const TEXTO_IMAGEM_RECUSADA = /O servidor não aceitou a imagem escolhida/;
const envelope = (status, codigo, detalhes = null) => ({ ok: false, status, dados: null, codigo, mensagem: 'x', detalhes });

// ─────────────────────────────────────────────────────────────────────
describe('5B-3 — cadastro: a imagem escolhida vai no POST', () => {
  for (const controle of ['unico', 'grade']) {
    test(`tamanho ${controle === 'unico' ? 'único' : 'com grade'}: o POST leva imagem { origem, id } (só essas chaves, id em texto) e o resto do corpo é o de sempre`, async () => {
      const { pg } = await P.abrir();
      await H.preencherCadastro(pg, { nome: 'Fita nova', controle, grade: controle === 'grade' ? '38, 39' : '' });
      await P.escolherImagem(pg, 2);
      await pg.clicar('botaoSalvar');
      assert.equal(P.posts(pg).length, 1);
      const corpo = P.posts(pg)[0].corpo;
      const esperado = { ...P.CORPO_TAMANHO_UNICO('Fita nova'), imagem: { origem: 'PADRAO', id: '1003' } };
      if (controle === 'grade') Object.assign(esperado, { exigeTamanho: true, tamanhos: ['38', '39'] });
      assert.deepEqual(corpo, esperado);
      assert.deepEqual(Object.keys(corpo.imagem).sort(), ['id', 'origem']);
      assert.equal(typeof corpo.imagem.id, 'string');
      P.aceitoPeloBackend('criar', corpo);
      assert.match(H.avisoDaPagina(pg), /^Material cadastrado com sucesso\./);
    });
  }

  test('imagem com id acima de 2^53: o texto exato chega ao servidor, sem passar por Number', async () => {
    const { pg } = await P.abrir();
    await H.preencherCadastro(pg, { nome: 'Fita grande' });
    await P.escolherImagem(pg, 29);
    await pg.clicar('botaoSalvar');
    const [chamada] = P.posts(pg);
    assert.ok(chamada.corpo.imagem, 'comportamento ausente: o POST deveria levar a imagem escolhida');
    assert.equal(chamada.corpo.imagem.id, H.ID_GRANDE);
    assert.ok(chamada.corpoBruto.includes(`"id":"${H.ID_GRANDE}"`), chamada.corpoBruto);
    assert.equal(P.aceitoPeloBackend('criar', chamada.corpo).imagem.id, H.ID_GRANDE);
  });

  test('escolher e remover antes de salvar: o POST não leva a chave imagem (nasce verde)', async () => {
    const { pg } = await P.abrir();
    await H.preencherCadastro(pg, { nome: 'Fita sem' });
    await P.escolherImagem(pg, 4);
    await pg.clicar(IDS.remover);
    P.semImagem(pg);
    await pg.clicar('botaoSalvar');
    assert.equal(P.posts(pg).length, 1);
    assert.equal(Object.hasOwn(P.posts(pg)[0].corpo, 'imagem'), false);
    assert.deepEqual(P.posts(pg)[0].corpo, P.CORPO_TAMANHO_UNICO('Fita sem'));
  });

  test('depois do cadastro confirmado o campo volta vazio e o cadastro seguinte, sem escolha, não leva imagem (nasce verde)', async () => {
    const { pg } = await P.abrir();
    await H.preencherCadastro(pg, { nome: 'Primeira' });
    await P.escolherImagem(pg, 2);
    await pg.clicar('botaoSalvar');
    P.semImagem(pg);
    await H.preencherCadastro(pg, { nome: 'Segunda' });
    await pg.clicar('botaoSalvar');
    assert.equal(P.posts(pg).length, 2);
    assert.equal(Object.hasOwn(P.posts(pg)[1].corpo, 'imagem'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B-3 — edição: a imagem gravada vem do servidor e só vai quando muda', () => {
  test('reabrir mostra a imagem gravada (nome, miniatura com a versão, "Remover seleção") e nenhuma escolha pendente', async () => {
    const { pg } = await P.abrir({ imagemInicial: reg(4) });
    await H.entrarNaEdicao(pg);
    P.comImagem(pg, imagens[4]);
    assert.match(pg.texto(IDS.estado), /gravada neste material/i);
    assert.equal(pg.el(IDS.escolher).disabled, false);
  });

  test('sem mudar nada, mesmo com imagem gravada: nenhum PATCH e o aviso "Nenhuma alteração para salvar." (nasce verde)', async () => {
    const { pg } = await P.abrir({ imagemInicial: reg(2) });
    await H.entrarNaEdicao(pg);
    await pg.clicar('botaoSalvar');
    assert.equal(P.escritas(pg).length, 0);
    assert.equal(H.avisoDaPagina(pg), MSG.EDICAO_SEM_ALTERACAO);
  });

  test('só outro campo muda: o PATCH leva só esse campo, sem a chave imagem (nasce verde)', async () => {
    const { pg } = await P.abrir({ imagemInicial: reg(2) });
    await H.entrarNaEdicao(pg);
    await H.digitarNoFormulario(pg, 'materialNome', 'Fita isolante azul');
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => c.corpo), [{ nome: 'Fita isolante azul' }]);
  });

  test('só a imagem muda: o PATCH leva { imagem } e nada mais, mesmo sem outra alteração cadastral', async () => {
    const { pg, estado } = await P.abrir({ imagemInicial: reg(2) });
    await H.entrarNaEdicao(pg);
    await P.escolherImagem(pg, 7);
    assert.match(pg.texto(IDS.estado), /será gravada ao salvar o material/i);
    assert.equal(P.patches(pg).length, 0, 'escolher na tela não grava nada');
    await pg.clicar('botaoSalvar');
    assert.equal(P.patches(pg).length, 1);
    assert.equal(P.patches(pg)[0].chave, 'PATCH /materiais/501');
    assert.deepEqual(P.patches(pg)[0].corpo, { imagem: { origem: 'PADRAO', id: '1008' } });
    P.aceitoPeloBackend('alterar', P.patches(pg)[0].corpo);
    assert.equal(H.avisoDaPagina(pg), MSG.EDICAO_SUCESSO);
    assert.deepEqual(estado.materiais.get(501).imagem, reg(7));
  });

  test('imagem e outro campo mudam juntos: um PATCH só, com os dois', async () => {
    const { pg } = await P.abrir({ imagemInicial: reg(2) });
    await H.entrarNaEdicao(pg);
    await H.digitarNoFormulario(pg, 'materialNome', 'Fita isolante azul');
    await P.escolherImagem(pg, 9);
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => c.corpo), [{ nome: 'Fita isolante azul', imagem: { origem: 'PADRAO', id: '1010' } }]);
    P.aceitoPeloBackend('alterar', P.patches(pg)[0].corpo);
  });

  test('remover a imagem gravada: o campo avisa que será removida e o PATCH leva { imagem: null }', async () => {
    const { pg, estado } = await P.abrir({ imagemInicial: reg(2) });
    await H.entrarNaEdicao(pg);
    await pg.clicar(IDS.remover);
    assert.match(pg.texto(IDS.estado), /Nenhuma imagem selecionada/);
    assert.match(pg.texto(IDS.estado), /removida ao salvar o material/i);
    assert.equal(P.patches(pg).length, 0, 'remover na tela não grava nada');
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => c.corpo), [{ imagem: null }]);
    P.aceitoPeloBackend('alterar', P.patches(pg)[0].corpo);
    assert.equal(estado.materiais.get(501).imagem, null);
    await H.entrarNaEdicao(pg);
    P.semImagem(pg);
    assert.doesNotMatch(pg.texto(IDS.estado), /removida/i, 'depois de salvo não há remoção pendente');
  });

  test('trocar e voltar à original, ou remover e escolher a mesma de novo: nada mudou e não há PATCH (nasce verde)', async () => {
    const { pg } = await P.abrir({ imagemInicial: reg(2) });
    await H.entrarNaEdicao(pg);
    await P.escolherImagem(pg, 11);
    await P.escolherImagem(pg, 2);
    await pg.clicar('botaoSalvar');
    assert.equal(P.escritas(pg).length, 0);
    assert.equal(H.avisoDaPagina(pg), MSG.EDICAO_SEM_ALTERACAO);
    await pg.clicar(IDS.remover);
    await P.escolherImagem(pg, 2);
    await pg.clicar('botaoSalvar');
    assert.equal(P.escritas(pg).length, 0);
  });

  test('material sem imagem: escolher uma grava com um PATCH só da imagem', async () => {
    const { pg } = await P.abrir();
    await H.entrarNaEdicao(pg);
    P.semImagem(pg);
    await P.escolherImagem(pg, 0);
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => c.corpo), [{ imagem: { origem: 'PADRAO', id: '1001' } }]);
  });

  test('ids vizinhos acima de 2^53 não se confundem: gravada ...993, escolher ...992 envia ...992 (comparação por texto)', async () => {
    const vizinhas = [{ ...imagens[0], id: '9007199254740992', nome: 'Vizinha A' }, { ...imagens[1], id: '9007199254740993', nome: 'Vizinha B' }];
    const { pg } = await P.abrir({ imagens: vizinhas, imagemInicial: P.registro(vizinhas[1]) });
    await H.entrarNaEdicao(pg);
    await P.escolherImagem(pg, 0);
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => c.corpo), [{ imagem: { origem: 'PADRAO', id: '9007199254740992' } }]);
    assert.ok(P.patches(pg)[0].corpoBruto.includes('"id":"9007199254740992"'), P.patches(pg)[0].corpoBruto);
  });

  test('imagem da biblioteca da EMPRESA (mostrada desde a 5C-8a): a edição a exibe e nada é enviado nem apagado se a pessoa não mexer nela (nasce verde)', async () => {
    const { pg, estado } = await P.abrir({ imagemInicial: { origem: 'EMPRESA', id: '77', versao: 1, nome: 'Foto da empresa' } });
    await H.entrarNaEdicao(pg);
    assert.equal(pg.consulta(`#${IDS.previa} img`).length, 1, 'a imagem da empresa aparece no campo');
    assert.ok(pg.texto(IDS.estado).includes('Foto da empresa'));
    await H.digitarNoFormulario(pg, 'materialNome', 'Fita isolante azul');
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => c.corpo), [{ nome: 'Fita isolante azul' }]);
    assert.equal(estado.materiais.get(501).imagem.origem, 'EMPRESA', 'a imagem da empresa segue gravada');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B-3 — reabrir depois de salvar lê o que o servidor gravou', () => {
  test('troca salva: o formulário volta a cadastro sem imagem e a edição seguinte mostra a imagem nova, lida do servidor', async () => {
    const { pg } = await P.abrir({ imagemInicial: reg(2) });
    await H.entrarNaEdicao(pg);
    await P.escolherImagem(pg, 12);
    await pg.clicar('botaoSalvar');
    assert.equal(P.patches(pg).length, 1);
    P.semImagem(pg);
    await H.entrarNaEdicao(pg);
    P.comImagem(pg, imagens[12]);
    assert.match(pg.texto(IDS.estado), /gravada neste material/i);
    await pg.clicar('botaoSalvar');
    assert.equal(P.patches(pg).length, 1, 'nada mudou depois de reabrir: nenhum segundo PATCH');
  });

  test('cadastro com imagem: abrir o material recém-criado para editar mostra a imagem gravada', async () => {
    const { pg, estado } = await P.abrir();
    await H.preencherCadastro(pg, { nome: 'Fita nova' });
    await P.escolherImagem(pg, 5);
    await pg.clicar('botaoSalvar');
    assert.deepEqual(estado.materiais.get(999).imagem, reg(5));
    await P.entrarNaEdicaoDe(pg, 999);
    assert.match(pg.texto('modoEdicao'), /Editando: Fita nova/);
    P.comImagem(pg, imagens[5]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B-3 — sem vazamento entre cadastro, edições e materiais', () => {
  test('cancelar a edição descarta a escolha pendente: o cadastro seguinte começa sem imagem e o POST não leva a chave (nasce verde)', async () => {
    const { pg } = await P.abrir({ imagemInicial: reg(2) });
    await H.entrarNaEdicao(pg);
    await P.escolherImagem(pg, 20);
    await pg.clicar('botaoCancelarEdicao');
    P.semImagem(pg);
    assert.equal(P.escritas(pg).length, 0);
    await H.preencherCadastro(pg, { nome: 'Depois do cancelamento' });
    await pg.clicar('botaoSalvar');
    assert.equal(P.posts(pg).length, 1);
    assert.equal(Object.hasOwn(P.posts(pg)[0].corpo, 'imagem'), false);
  });

  test('abrir a edição de outro material mostra a imagem dele e não herda a escolha pendente do anterior', async () => {
    const outro = { ...H.MATERIAL, id: 502, nome: 'Fita autofusão', imagem: reg(5) };
    const { pg } = await P.abrir({ imagemInicial: reg(2), outros: [outro] });
    await H.entrarNaEdicao(pg);
    await P.escolherImagem(pg, 9);
    await P.entrarNaEdicaoDe(pg, 502);
    assert.match(pg.texto('modoEdicao'), /Editando: Fita autofusão/);
    P.comImagem(pg, imagens[5]);
    await H.digitarNoFormulario(pg, 'materialNome', 'Fita autofusão preta');
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => [c.chave, c.corpo]), [['PATCH /materiais/502', { nome: 'Fita autofusão preta' }]]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B-3 — erros da gravação: a imagem não é confundida com o material e nada é repetido sozinho', () => {
  const soComImagem = (resposta) => (c, padrao) => (Object.hasOwn(c.corpo, 'imagem') ? resposta() : padrao(c));

  test('cadastro: 404 IMAGEM_NAO_ENCONTRADA tem texto próprio, preserva formulário e escolha, e sem a imagem o mesmo cadastro passa', async () => {
    const { pg } = await P.abrir({ respostas: { 'POST /materiais': soComImagem(P.ERRO_IMAGEM_NAO_ENCONTRADA) } });
    await H.preencherCadastro(pg, { nome: 'Fita nova' });
    await P.escolherImagem(pg, 3);
    await pg.clicar('botaoSalvar');
    const aviso = H.avisoDaPagina(pg);
    assert.match(aviso, TEXTO_IMAGEM_AUSENTE);
    assert.doesNotMatch(aviso, /Material não encontrado|Não foi possível cadastrar/);
    assert.equal(P.posts(pg).length, 1, 'uma tentativa só');
    assert.equal(pg.el('materialNome').value, 'Fita nova');
    P.comImagem(pg, imagens[3]);
    assert.match(pg.texto(IDS.estado), /será gravada/i);
    await pg.clicar(IDS.remover);
    await pg.clicar('botaoSalvar');
    assert.equal(P.posts(pg).length, 2);
    assert.equal(Object.hasOwn(P.posts(pg)[1].corpo, 'imagem'), false);
    assert.match(H.avisoDaPagina(pg), /^Material cadastrado com sucesso\./);
  });

  test('edição: 404 IMAGEM_NAO_ENCONTRADA não vira "Material não encontrado nesta empresa."; formulário e escolha seguem na tela', async () => {
    const { pg } = await P.abrir({ imagemInicial: reg(2), respostas: { 'PATCH /materiais/501': soComImagem(P.ERRO_IMAGEM_NAO_ENCONTRADA) } });
    await H.entrarNaEdicao(pg);
    await P.escolherImagem(pg, 8);
    await pg.clicar('botaoSalvar');
    const aviso = H.avisoDaPagina(pg);
    assert.match(aviso, TEXTO_IMAGEM_AUSENTE);
    assert.notEqual(aviso, MSG.NAO_ENCONTRADO);
    assert.doesNotMatch(aviso, /Material não encontrado/);
    assert.equal(P.patches(pg).length, 1, 'uma tentativa só');
    assert.equal(pg.visivel('modoEdicao'), true, 'segue em edição');
    P.comImagem(pg, imagens[8]);
    assert.match(pg.texto(IDS.estado), /será gravada/i);
  });

  test('404 que não é da imagem mantém o texto de sempre: material inexistente, rota desconhecida (API antiga) e 404 sem código', async () => {
    const respostas = [P.ERRO_MATERIAL_NAO_ENCONTRADO(), P.erroDe(404, 'ROTA_NAO_ENCONTRADA', 'Rota não encontrada'), { status: 404, corpo: { status: 'error' } }];
    for (const resposta of respostas) {
      const { pg } = await P.abrir({ imagemInicial: reg(2), respostas: { 'PATCH /materiais/501': () => resposta } });
      await H.entrarNaEdicao(pg);
      await P.escolherImagem(pg, 8);
      await pg.clicar('botaoSalvar');
      assert.equal(H.avisoDaPagina(pg), MSG.NAO_ENCONTRADO, JSON.stringify(resposta.corpo));
      assert.doesNotMatch(H.avisoDaPagina(pg), TEXTO_IMAGEM_AUSENTE);
    }
  });

  test('400 em body.imagem tem texto próprio no cadastro e na edição; 400 de outro campo segue a mensagem de sempre (que cita os campos)', async () => {
    const recusaDaImagem = () => P.erro400('body.imagem.id', 'ID_INVALIDO', 'Identificador inválido');
    {
      const { pg } = await P.abrir({ respostas: { 'POST /materiais': recusaDaImagem } });
      await H.preencherCadastro(pg, { nome: 'Fita nova' });
      await P.escolherImagem(pg, 3);
      await pg.clicar('botaoSalvar');
      assert.match(H.avisoDaPagina(pg), TEXTO_IMAGEM_RECUSADA, 'cadastro');
      assert.equal(P.posts(pg).length, 1);
      P.comImagem(pg, imagens[3]);
    }
    {
      const { pg } = await P.abrir({ imagemInicial: reg(2), respostas: { 'PATCH /materiais/501': recusaDaImagem } });
      await H.entrarNaEdicao(pg);
      await P.escolherImagem(pg, 8);
      await pg.clicar('botaoSalvar');
      assert.match(H.avisoDaPagina(pg), TEXTO_IMAGEM_RECUSADA, 'edição');
      assert.equal(P.patches(pg).length, 1);
      P.comImagem(pg, imagens[8]);
    }
    {
      const outroCampo = () => P.erro400('body.nome', 'TAMANHO_MAXIMO', 'Tamanho máximo excedido');
      const { pg } = await P.abrir({ imagemInicial: reg(2), respostas: { 'PATCH /materiais/501': outroCampo } });
      await H.entrarNaEdicao(pg);
      await P.escolherImagem(pg, 8);
      await pg.clicar('botaoSalvar');
      const esperado = EpiMateriais.mensagens.erroEdicao(envelope(400, 'VALIDACAO', [{ campo: 'body.nome', codigo: 'TAMANHO_MAXIMO', mensagem: 'x' }]));
      assert.equal(H.avisoDaPagina(pg), esperado, 'outro campo');
      assert.doesNotMatch(H.avisoDaPagina(pg), TEXTO_IMAGEM_RECUSADA);
    }
  });

  test('recusas que não são da imagem (403 e 409 de código duplicado) mantêm os textos de sempre e a escolha pendente (nasce verde)', async () => {
    const casos = [
      ['cadastro 403', 'POST /materiais', P.erroDe(403, 'PERMISSAO_NEGADA', 'x'), EpiMateriais.mensagens.erroCadastro(envelope(403, 'PERMISSAO_NEGADA'))],
      ['cadastro 409', 'POST /materiais', P.erroDe(409, 'MATERIAL_CODIGO_INTERNO_DUPLICADO', 'x'), MSG.CODIGO_DUPLICADO],
      ['edição 403', 'PATCH /materiais/501', P.erroDe(403, 'PERMISSAO_NEGADA', 'x'), MSG.SEM_EDITAR],
      ['edição 409', 'PATCH /materiais/501', P.erroDe(409, 'MATERIAL_CODIGO_INTERNO_DUPLICADO', 'x'), MSG.CODIGO_DUPLICADO],
    ];
    for (const [rotulo, rota, resposta, esperado] of casos) {
      const emEdicao = rota.startsWith('PATCH');
      const { pg } = await P.abrir({ imagemInicial: emEdicao ? reg(2) : null, respostas: { [rota]: () => resposta } });
      if (emEdicao) await H.entrarNaEdicao(pg); else await H.preencherCadastro(pg, { nome: 'Fita nova' });
      await P.escolherImagem(pg, 8);
      await pg.clicar('botaoSalvar');
      assert.equal(H.avisoDaPagina(pg), esperado, rotulo);
      P.comImagem(pg, imagens[8]);
      assert.equal((emEdicao ? P.patches(pg) : P.posts(pg)).length, 1, rotulo);
    }
  });

  test('sessão encerrada (401) ao gravar: o tratamento de sempre, devolvendo ao Portal, e nenhuma segunda escrita', async () => {
    for (const rota of ['POST /materiais', 'PATCH /materiais/501']) {
      const emEdicao = rota.startsWith('PATCH');
      const { pg } = await P.abrir({ imagemInicial: emEdicao ? reg(2) : null, respostas: { [rota]: () => P.erroDe(401, 'NAO_AUTENTICADO', 'x') } });
      if (emEdicao) await H.entrarNaEdicao(pg); else await H.preencherCadastro(pg, { nome: 'Fita nova' });
      await P.escolherImagem(pg, 8);
      await pg.clicar('botaoSalvar');
      assert.ok(pg.navegacoes.some((n) => /portal\//.test(n)), `${rota}: volta ao Portal (${JSON.stringify(pg.navegacoes)})`);
      assert.equal(P.escritas(pg).length, 1, rota);
    }
  });

  const INCONCLUSIVOS = [
    ['falha de rede', () => new Error('rede caiu')],
    ['erro 500', () => P.erroDe(500, 'ERRO_INTERNO', 'x')],
    ['erro 503', () => P.erroDe(503, 'SERVICO_INDISPONIVEL', 'x')],
    ['resposta que não é JSON', () => ({ status: 200, texto: '<html>proxy</html>' })],
  ];

  test('cadastro sem confirmação (rede, 5xx ou resposta ilegível): formulário e escolha preservados, uma tentativa só, sem repetição automática', async () => {
    for (const [rotulo, resposta] of INCONCLUSIVOS) {
      const { pg } = await P.abrir({ respostas: { 'POST /materiais': resposta } });
      await H.preencherCadastro(pg, { nome: 'Fita nova' });
      await P.escolherImagem(pg, 3);
      await pg.clicar('botaoSalvar');
      await pg.avancar();
      assert.equal(P.posts(pg).length, 1, rotulo);
      assert.equal(pg.el('materialNome').value, 'Fita nova', rotulo);
      P.comImagem(pg, imagens[3]);
      assert.match(pg.texto(IDS.estado), /será gravada/i, rotulo);
      assert.doesNotMatch(H.avisoDaPagina(pg), TEXTO_IMAGEM_AUSENTE, rotulo);
    }
  });

  test('cadastro: depois da falha de rede só a pessoa repete, com o mesmo corpo e a mesma imagem', async () => {
    let tentativa = 0;
    const { pg } = await P.abrir({ respostas: { 'POST /materiais': (c, padrao) => { tentativa += 1; return tentativa === 1 ? new Error('rede caiu') : padrao(c); } } });
    await H.preencherCadastro(pg, { nome: 'Fita nova' });
    await P.escolherImagem(pg, 3);
    await pg.clicar('botaoSalvar');
    assert.equal(P.posts(pg).length, 1);
    await pg.clicar('botaoSalvar');
    assert.equal(P.posts(pg).length, 2);
    assert.deepEqual(P.posts(pg)[1].corpo, P.posts(pg)[0].corpo);
    assert.deepEqual(P.posts(pg)[1].corpo.imagem, { origem: 'PADRAO', id: '1004' });
    assert.match(H.avisoDaPagina(pg), /^Material cadastrado com sucesso\./);
  });

  test('edição sem confirmação (rede, 5xx ou resposta ilegível): segue em edição com a escolha pendente, um PATCH só, sem repetição automática', async () => {
    for (const [rotulo, resposta] of INCONCLUSIVOS) {
      const { pg } = await P.abrir({ imagemInicial: reg(2), respostas: { 'PATCH /materiais/501': resposta } });
      await H.entrarNaEdicao(pg);
      await P.escolherImagem(pg, 8);
      await pg.clicar('botaoSalvar');
      await pg.avancar();
      assert.equal(P.patches(pg).length, 1, rotulo);
      assert.equal(pg.visivel('modoEdicao'), true, rotulo);
      P.comImagem(pg, imagens[8]);
      assert.match(pg.texto(IDS.estado), /será gravada/i, rotulo);
    }
  });

  test('edição: depois da falha de rede só a pessoa repete, com o mesmo corpo, e então a imagem fica gravada', async () => {
    let tentativa = 0;
    const { pg, estado } = await P.abrir({ imagemInicial: reg(2), respostas: { 'PATCH /materiais/501': (c, padrao) => { tentativa += 1; return tentativa === 1 ? new Error('rede caiu') : padrao(c); } } });
    await H.entrarNaEdicao(pg);
    await P.escolherImagem(pg, 8);
    await pg.clicar('botaoSalvar');
    assert.equal(P.patches(pg).length, 1);
    await pg.clicar('botaoSalvar');
    assert.equal(P.patches(pg).length, 2);
    assert.deepEqual(P.patches(pg)[1].corpo, P.patches(pg)[0].corpo);
    assert.deepEqual(estado.materiais.get(501).imagem, reg(8));
    assert.equal(H.avisoDaPagina(pg), MSG.EDICAO_SUCESSO);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B-3 — permissões: só quem pode criar ou editar escolhe e grava', () => {
  test('só com materials.editar: a edição grava a troca da imagem; sem materials.criar o cadastro continua sem nada para enviar', async () => {
    const p = H.permissoes({ materials: { visualizar: true, criar: false, editar: true, excluir: false } });
    const { pg } = await P.abrir({ p, imagemInicial: reg(2) });
    assert.equal(pg.el(IDS.escolher).disabled, true, 'cadastro sem materials.criar');
    await H.entrarNaEdicao(pg);
    await P.escolherImagem(pg, 6);
    await pg.clicar('botaoSalvar');
    assert.deepEqual(P.patches(pg).map((c) => c.corpo), [{ imagem: { origem: 'PADRAO', id: '1007' } }]);
    assert.equal(P.posts(pg).length, 0);
    assert.equal(pg.el(IDS.escolher).disabled, true, 'de volta ao cadastro, desabilitado');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5B-3 — orientação verdadeira: a imagem escolhida é gravada ao salvar o material', () => {
  test('a ajuda do campo, o diálogo e os estados do campo dizem isso, e nenhum fala mais em prévia nem em "ainda não gravada"', async () => {
    const ruim = /ainda não é gravada|só uma prévia|prévia/i;
    const verdade = /gravada.{0,40}salvar o material/i;
    const { pg } = await P.abrir({ imagemInicial: reg(2) });
    assert.match(pg.texto(IDS.campo), verdade, 'ajuda do campo');
    assert.doesNotMatch(pg.texto(IDS.campo), ruim, 'ajuda do campo');
    await H.abrirSeletor(pg);
    assert.match(pg.texto(IDS.modal), verdade, 'descrição do diálogo');
    assert.doesNotMatch(pg.texto(IDS.modal), ruim, 'diálogo');
    await H.marcar(pg, 3);
    await H.confirmar(pg);
    assert.match(pg.texto(IDS.estado), /será gravada ao salvar o material/i, 'escolha pendente no cadastro');
    assert.doesNotMatch(pg.texto(IDS.campo), ruim, 'escolha pendente no cadastro');
    await pg.clicar(IDS.remover);
    await H.entrarNaEdicao(pg);
    assert.match(pg.texto(IDS.estado), /gravada neste material/i, 'imagem já gravada');
    assert.doesNotMatch(pg.texto(IDS.campo), ruim, 'imagem já gravada');
    await P.escolherImagem(pg, 9);
    assert.match(pg.texto(IDS.estado), /será gravada ao salvar o material/i, 'troca pendente');
    assert.doesNotMatch(pg.texto(IDS.campo), ruim, 'troca pendente');
    await pg.clicar(IDS.remover);
    assert.match(pg.texto(IDS.estado), /removida ao salvar o material/i, 'remoção pendente');
    assert.doesNotMatch(pg.texto(IDS.campo), ruim, 'remoção pendente');
  });
});
