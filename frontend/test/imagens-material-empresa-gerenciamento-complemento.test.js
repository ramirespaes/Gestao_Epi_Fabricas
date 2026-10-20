'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');
const E = require('./helpers/imagens-material-empresa');

/**
 * Unidade 5C-8b — complemento do gerenciamento das imagens da empresa: o que os dez pendentes GE-T01 a GE-T10 (imagens-material-empresa-gerenciamento.test.js) não dizem no
 * título. Disparo único por ação (clique duplo, Enter repetido, confirmação repetida) com a resposta do servidor SEGURADA; estados de processamento e de carregamento; falhas
 * de leitura e de escrita (401, 403, 429, 503, 500, rede) sem repetição automática; operações idempotentes ("já estava inativa"); o seletor relido depois de gerenciar; só a
 * biblioteca da empresa (nunca a Padrão); mais de 100 imagens; permissão e sessão que mudam com o pop-up aberto; e a mensagem de 429/503 do envio dita uma vez só.
 * Páginas reais no harness de DOM e biblioteca simulada com estado, sem PostgreSQL, sem API e sem upload real.
 */

const { H, P } = E;
const { IDS } = H;

const EMPRESA = [{ id: '5001', nome: 'Luva da empresa', versao: 1 }, { id: '5002', nome: 'Botina antiga da empresa', versao: 3 }];
const abrirCom = (empresa = EMPRESA, extra = {}) => E.abrir({ biblioteca: E.criarBiblioteca({ empresa, proximoId: 6001 }), ...extra });
const GES = {
  vista: 'imagemVistaGestao', lista: 'imagemGestaoLista', aviso: 'imagemGestaoAviso', estado: 'imagemGestaoEstado', contagem: 'imagemGestaoContagem', titulo: 'imagemGestaoTitulo',
  inativas: 'imagemGestaoInativas', concluir: 'botaoImagemGestaoConcluir', atualizar: 'botaoImagemGestaoAtualizar', fechar: 'botaoImagemGestaoFechar',
};
const TRAVAVEIS = [GES.concluir, GES.fechar, GES.atualizar, GES.inativas];

const botaoGerenciar = (pg) => E.botaoPorNome(E.modal(pg), /^Gerenciar imagens$/);
const linhasDaGestao = (pg) => pg.el(GES.lista).children;
const linhaPorId = (pg, id) => linhasDaGestao(pg).find((li) => li.getAttribute('data-imagem-id') === id) ?? null;
const campoDoNomeDe = (pg, id) => linhaPorId(pg, id).querySelectorAll('input').find((i) => i.type === 'text') ?? null;
const botaoDaLinha = (linha, verbo) => linha.querySelectorAll('button').find((b) => E.nomeAcessivel(b).startsWith(verbo)) ?? null;
// Nó do DOM nunca vai para assert.equal: na falha o Node monta a mensagem inspecionando o grafo circular do nó e o processo trava. Compara-se a identidade.
const mesmo = (real, esperado, mensagem) => assert.ok(real === esperado, mensagem);
const nulo = (real, mensagem) => assert.ok(real === null, mensagem);
const escritas = (pg) => pg.chamadas.filter((c) => c.metodo !== 'GET');
const leituras = (pg) => E.chamadasDaLista(pg).length;
const avisoDaGestao = (pg) => E.normalizarTexto(pg.texto(GES.aviso));
const estadoDaGestao = (pg) => E.normalizarTexto(pg.texto(GES.estado));
const leituraDaGestao = (c) => new URL(c.url).searchParams.get('estado') === 'TODAS';

/** Uma resposta do servidor que só sai quando `liberar()` for chamada; `seguradaEm` a encaixa em `respostas` (a regra normal da biblioteca simulada responde depois). */
function segurarRota() {
  let liberar;
  const espera = new Promise((resolve) => { liberar = resolve; });
  return { espera, liberar };
}
const seguradaEm = (pausa, quando = () => true) => async (c, regra) => {
  if (quando(c)) await pausa.espera;
  return regra(c);
};
const falhaEm = (resposta, quando = () => true) => (c, regra) => (quando(c) ? resposta : regra(c));

async function abrirGerenciar(pg) {
  await H.abrirSeletor(pg);
  await E.irParaAba(pg, 'Minha Empresa');
  await botaoGerenciar(pg).disparar('click');
  await E.aguardar(pg);
}

/** Faz a ação de gerenciar sobre a imagem `id` do começo ao fim (renomear = 'Nome novo' + Enter; excluir = Excluir + “Excluir imagem”) e espera a tela assentar. */
async function agirSobre(pg, id, acao) {
  const linha = () => linhaPorId(pg, id);
  if (acao === 'EXCLUIR') {
    await botaoDaLinha(linha(), 'Excluir').disparar('click');
    await pg.esperar();
    await botaoDaLinha(linha(), 'Excluir imagem').disparar('click');
  } else if (acao === 'RENOMEAR') {
    await botaoDaLinha(linha(), 'Renomear').disparar('click');
    await pg.esperar();
    campoDoNomeDe(pg, id).value = 'Nome novo';
    await campoDoNomeDe(pg, id).disparar('input');
    await H.pressionar(campoDoNomeDe(pg, id), 'Enter');
  } else {
    await botaoDaLinha(linha(), acao === 'INATIVAR' ? 'Inativar' : 'Reativar').disparar('click');
  }
  await E.aguardar(pg);
}

// ─────────────────────────────────────────────────────────────────────
describe('5C-8b GC — um disparo por ação e estados de processamento', () => {
  test('GC-01 clique duplo em “Inativar” (no mesmo instante e depois, no botão já substituído) envia UMA requisição; enquanto espera, a linha diz “Inativando…” e todo o resto fica travado, sem fechar o pop-up', async () => {
    const pausa = segurarRota();
    const { pg, b } = await abrirCom(EMPRESA, { respostas: { 'POST /imagens-material/empresa/5001/inativar': seguradaEm(pausa) } });
    await abrirGerenciar(pg);
    const botao = botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar');
    await Promise.all([botao.disparar('click'), botao.disparar('click')]);
    await pg.esperar();
    await botao.disparar('click');
    await pg.esperar();
    assert.equal(escritas(pg).length, 1, 'uma requisição só');
    const linha = linhaPorId(pg, '5001');
    assert.match(E.textoVisivel(linha), /Inativando…/);
    assert.equal(linha.getAttribute('aria-busy'), 'true');
    assert.equal(pg.el(GES.lista).getAttribute('aria-busy'), 'true');
    for (const li of linhasDaGestao(pg)) for (const x of li.querySelectorAll('button')) assert.equal(x.disabled, true, E.nomeAcessivel(x));
    for (const id of TRAVAVEIS) assert.equal(pg.el(id).disabled, true, id);
    await H.pressionar(pg.el(GES.lista), 'Escape');
    await pg.esperar();
    assert.equal(E.modal(pg).getAttribute('aria-hidden'), 'false', 'Escape não fecha o pop-up no meio da operação');
    assert.equal(b.acharEmpresa('5001').estado, 'ATIVA', 'o servidor ainda não respondeu');
    pausa.liberar();
    await E.aguardar(pg);
    assert.equal(escritas(pg).length, 1);
    assert.equal(b.acharEmpresa('5001').estado, 'INATIVA');
    assert.match(avisoDaGestao(pg), /foi inativada/);
    for (const id of TRAVAVEIS) assert.equal(pg.el(id).disabled, false, id);
    assert.equal(pg.el(GES.lista).getAttribute('aria-busy'), 'false');
  });

  test('GC-02 Enter repetido no nome e clique repetido em “Excluir imagem” também enviam uma só requisição cada, com “Renomeando…” e “Excluindo…” na linha', async () => {
    const pausaNome = segurarRota();
    const pausaExcluir = segurarRota();
    const { pg, b } = await abrirCom(EMPRESA, {
      respostas: { 'PATCH /imagens-material/empresa/5001': seguradaEm(pausaNome), 'DELETE /imagens-material/empresa/5002': seguradaEm(pausaExcluir) },
    });
    await abrirGerenciar(pg);
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear').disparar('click');
    await pg.esperar();
    const campo = campoDoNomeDe(pg, '5001');
    campo.value = 'Luva B';
    await campo.disparar('input');
    await Promise.all([H.pressionar(campo, 'Enter'), H.pressionar(campo, 'Enter')]);
    await pg.esperar();
    await H.pressionar(campo, 'Enter');
    await pg.esperar();
    assert.deepEqual(escritas(pg).map((c) => c.metodo), ['PATCH']);
    assert.match(E.textoVisivel(linhaPorId(pg, '5001')), /Renomeando…/);
    assert.equal(campoDoNomeDe(pg, '5001').disabled, true, 'o campo fica travado enquanto espera');
    pausaNome.liberar();
    await E.aguardar(pg);
    assert.match(avisoDaGestao(pg), /agora se chama “Luva B”/);
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Excluir').disparar('click');
    await pg.esperar();
    const confirmar = botaoDaLinha(linhaPorId(pg, '5002'), 'Excluir imagem');
    await Promise.all([confirmar.disparar('click'), confirmar.disparar('click')]);
    await pg.esperar();
    await confirmar.disparar('click');
    await pg.esperar();
    assert.deepEqual(escritas(pg).map((c) => c.metodo), ['PATCH', 'DELETE']);
    assert.match(E.textoVisivel(linhaPorId(pg, '5002')), /Excluindo…/);
    assert.equal(avisoDaGestao(pg), '', 'o aviso da operação anterior some quando outra começa');
    pausaExcluir.liberar();
    await E.aguardar(pg);
    assert.deepEqual(escritas(pg).map((c) => c.metodo), ['PATCH', 'DELETE']);
    assert.equal(b.empresa.length, 1);
    nulo(linhaPorId(pg, '5002'));
  });

  test('GC-03 estado de carregamento da lista: “Carregando…”, nenhuma linha e “Atualizar lista” travado; sair antes da resposta descarta a resposta tardia, e entrar de novo lê a lista', async () => {
    const pausa = segurarRota();
    const { pg } = await abrirCom(EMPRESA, { respostas: { 'GET /imagens-material': seguradaEm(pausa, leituraDaGestao) } });
    await H.abrirSeletor(pg);
    await E.irParaAba(pg, 'Minha Empresa');
    const entrando = botaoGerenciar(pg).disparar('click'); // o clique só termina quando a leitura termina: não se aguarda antes de liberar
    await E.aguardar(pg);
    assert.equal(pg.visivelNo(pg.el(GES.vista)), true);
    assert.match(estadoDaGestao(pg), /Carregando as imagens da empresa…/);
    assert.equal(linhasDaGestao(pg).length, 0);
    assert.equal(pg.el(GES.atualizar).disabled, true);
    assert.equal(pg.el(GES.lista).getAttribute('aria-busy'), 'true');
    await pg.el(GES.concluir).disparar('click');
    await pg.esperar();
    assert.equal(pg.visivelNo(pg.el('imagemVistaBiblioteca')), true, 'dá para sair enquanto carrega');
    pausa.liberar();
    await entrando;
    await E.aguardar(pg);
    assert.equal(linhasDaGestao(pg).length, 0, 'a resposta tardia não escreve na vista que já fechou');
    assert.equal(estadoDaGestao(pg), '');
    await botaoGerenciar(pg).disparar('click');
    await E.aguardar(pg);
    assert.equal(linhasDaGestao(pg).length, 2);
    assert.equal(estadoDaGestao(pg), '');
    assert.equal(pg.el(GES.atualizar).disabled, false);
  });

  test('GC-04 “Mostrar inativas” só filtra o que já foi lido (nenhuma requisição) e “Atualizar lista” lê de novo uma vez, mantendo o filtro e trazendo o que mudou no servidor', async () => {
    const { pg, b } = await abrirCom([...EMPRESA, { id: '5003', nome: 'Capacete antigo', versao: 1, estado: 'INATIVA' }]);
    await abrirGerenciar(pg);
    const aposEntrar = leituras(pg);
    assert.equal(linhasDaGestao(pg).length, 2);
    pg.el(GES.inativas).checked = false;
    await pg.el(GES.inativas).disparar('click');
    await pg.esperar();
    assert.equal(linhasDaGestao(pg).length, 3);
    pg.el(GES.inativas).checked = true;
    await pg.el(GES.inativas).disparar('click');
    await pg.esperar();
    assert.equal(linhasDaGestao(pg).length, 2);
    assert.equal(leituras(pg), aposEntrar, 'filtrar não lê nada');
    assert.equal(escritas(pg).length, 0);
    b.empresa.push({ ...b.empresa[0], id: '5004', nome: 'Óculos novo', sha: 'novo-5004' });
    pg.el(GES.inativas).checked = false;
    await pg.el(GES.inativas).disparar('click');
    await pg.esperar();
    await pg.el(GES.atualizar).disparar('click');
    await E.aguardar(pg);
    assert.equal(leituras(pg), aposEntrar + 1, 'uma leitura só');
    assert.deepEqual(linhasDaGestao(pg).map((li) => li.getAttribute('data-imagem-id')).sort(), ['5001', '5002', '5003', '5004'], 'o filtro de inativas continua valendo e a imagem nova apareceu');
    assert.equal(escritas(pg).length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-8b GC — falhas: o motivo aparece, nada é repetido sozinho e o servidor é a autoridade', () => {
  test('GC-05 a leitura da lista falha (503, rede, 500): o motivo aparece, nenhuma linha é inventada e “Atualizar lista” tenta de novo; o texto do servidor nunca aparece', async () => {
    const casos = [
      ['503', P.erroDe(503, 'IMAGENS_INDISPONIVEL', E.TEXTO_DO_SERVIDOR), /indisponível no momento/],
      ['rede', new Error('rede'), /Falha de rede: não foi possível carregar/],
      ['500', P.erroDe(500, 'ERRO_INTERNO', E.TEXTO_DO_SERVIDOR), /Não foi possível carregar as imagens/],
    ];
    for (const [rotulo, falha, texto] of casos) {
      let falhar = true;
      const { pg } = await abrirCom(EMPRESA, { respostas: { 'GET /imagens-material': (c, regra) => (falhar && leituraDaGestao(c) ? falha : regra(c)) } });
      await abrirGerenciar(pg);
      assert.match(estadoDaGestao(pg), texto, rotulo);
      assert.equal(linhasDaGestao(pg).length, 0, rotulo);
      assert.equal(pg.el(GES.contagem).textContent, '', rotulo);
      assert.equal(pg.el(GES.atualizar).disabled, false, `${rotulo}: dá para tentar de novo`);
      assert.equal(pg.textoDoDom().includes(E.TEXTO_DO_SERVIDOR), false, rotulo);
      falhar = false;
      await pg.el(GES.atualizar).disparar('click');
      await E.aguardar(pg);
      assert.equal(linhasDaGestao(pg).length, 2, rotulo);
      assert.equal(estadoDaGestao(pg), '', rotulo);
    }
    const sessao = await abrirCom(EMPRESA, { respostas: { 'GET /imagens-material': falhaEm(P.erroDe(401, 'NAO_AUTENTICADO', E.TEXTO_DO_SERVIDOR), leituraDaGestao) } });
    await abrirGerenciar(sessao.pg);
    assert.ok(sessao.pg.navegacoes.some((n) => /portal\//.test(n)), 'sessão encerrada devolve ao Portal');
  });

  test('GC-06 falha ao inativar: 429, 503, 500, 403 e rede dão cada um o seu texto, a linha volta a ser usável, a requisição não é repetida e só rede e 500 relêem a lista', async () => {
    const casos = [
      ['429', P.erroDe(429, 'LIMITE_REQUISICOES_EXCEDIDO', E.TEXTO_DO_SERVIDOR), /Muitas operações em pouco tempo/, false],
      ['503', P.erroDe(503, 'IMAGENS_INDISPONIVEL', E.TEXTO_DO_SERVIDOR), /indisponível no momento/, false],
      ['403', P.erroDe(403, 'SEM_PERMISSAO', E.TEXTO_DO_SERVIDOR), /Sem permissão para gerenciar/, false],
      ['500', P.erroDe(500, 'ERRO_INTERNO', E.TEXTO_DO_SERVIDOR), /Não foi possível concluir a operação\. Tente novamente\./, true],
      ['rede', new Error('rede'), /Falha de rede: não foi possível concluir a operação/, true],
    ];
    for (const [rotulo, falha, texto, relê] of casos) {
      const { pg, b } = await abrirCom(EMPRESA, { respostas: { 'POST /imagens-material/empresa/5001/inativar': () => falha } });
      await abrirGerenciar(pg);
      const antes = leituras(pg);
      await botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar').disparar('click');
      await E.aguardar(pg);
      assert.match(avisoDaGestao(pg), texto, rotulo);
      assert.equal(pg.el(GES.aviso).getAttribute('class').includes('bi-aviso-erro'), true, `${rotulo}: aviso de erro`);
      await pg.avancar();
      assert.equal(escritas(pg).length, 1, `${rotulo}: nenhuma repetição automática`);
      assert.equal(leituras(pg), antes + (relê ? 1 : 0), `${rotulo}: ${relê ? 'resultado incerto, a lista é relida' : 'a lista não é relida'}`);
      assert.equal(b.acharEmpresa('5001').estado, 'ATIVA', rotulo);
      const botao = botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar');
      assert.equal(botao.disabled, false, `${rotulo}: a linha volta a ser usável`);
      for (const id of TRAVAVEIS) assert.equal(pg.el(id).disabled, false, `${rotulo}: ${id}`);
      assert.equal(pg.textoDoDom().includes(E.TEXTO_DO_SERVIDOR), false, rotulo);
    }
  });

  test('GC-07 sessão encerrada (401) em qualquer operação devolve ao Portal sem reler a lista nem repetir a requisição', async () => {
    const operacoes = [
      ['PATCH /imagens-material/empresa/5001', async (pg) => {
        await botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear').disparar('click');
        await pg.esperar();
        campoDoNomeDe(pg, '5001').value = 'Outro nome';
        await campoDoNomeDe(pg, '5001').disparar('input');
        await H.pressionar(campoDoNomeDe(pg, '5001'), 'Enter');
      }],
      ['POST /imagens-material/empresa/5001/inativar', (pg) => botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar').disparar('click')],
      ['DELETE /imagens-material/empresa/5001', async (pg) => {
        await botaoDaLinha(linhaPorId(pg, '5001'), 'Excluir').disparar('click');
        await pg.esperar();
        await botaoDaLinha(linhaPorId(pg, '5001'), 'Excluir imagem').disparar('click');
      }],
    ];
    for (const [rota, agir] of operacoes) {
      const { pg } = await abrirCom(EMPRESA, { respostas: { [rota]: () => P.erroDe(401, 'NAO_AUTENTICADO', E.TEXTO_DO_SERVIDOR) } });
      await abrirGerenciar(pg);
      const antes = leituras(pg);
      await agir(pg);
      await E.aguardar(pg);
      assert.ok(pg.navegacoes.some((n) => /portal\//.test(n)), `${rota}: volta ao Portal`);
      assert.equal(escritas(pg).length, 1, rota);
      assert.equal(leituras(pg), antes, `${rota}: a lista não é relida`);
    }
  });

  test('GC-08 recusa do servidor ao renomear (400 em body.nome): o campo continua aberto com o que foi digitado e o motivo aparece nele, sem texto do servidor', async () => {
    const recusa = P.erroDe(400, 'VALIDACAO', E.TEXTO_DO_SERVIDOR);
    recusa.corpo.detalhes = [{ campo: 'body.nome', codigo: 'NOME_INVALIDO', mensagem: E.TEXTO_DO_SERVIDOR }];
    const { pg } = await abrirCom(EMPRESA, { respostas: { 'PATCH /imagens-material/empresa/5001': () => recusa } });
    await abrirGerenciar(pg);
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear').disparar('click');
    await pg.esperar();
    campoDoNomeDe(pg, '5001').value = 'Nome que o servidor recusa';
    await campoDoNomeDe(pg, '5001').disparar('input');
    await H.pressionar(campoDoNomeDe(pg, '5001'), 'Enter');
    await E.aguardar(pg);
    assert.equal(campoDoNomeDe(pg, '5001').value, 'Nome que o servidor recusa', 'o que foi digitado fica');
    assert.match(E.normalizarTexto(E.textoVisivel(linhaPorId(pg, '5001'))), /Informe um nome de 1 a 100 caracteres/);
    assert.match(avisoDaGestao(pg), /O nome da imagem não foi aceito/);
    assert.equal(pg.textoDoDom().includes(E.TEXTO_DO_SERVIDOR), false);
    assert.equal(escritas(pg).length, 1);
    assert.equal(botaoDaLinha(linhaPorId(pg, '5001'), 'Salvar nome').disabled, false, 'dá para corrigir e salvar de novo');
  });

  test('GC-09 operações idempotentes: o servidor diz que nada mudou (outra pessoa já fez) e a tela diz “já estava inativa”, “já estava ativa” e “já era”, atualizando a linha', async () => {
    const { pg, b } = await abrirCom([...EMPRESA, { id: '5003', nome: 'Capacete antigo', versao: 1, estado: 'INATIVA' }]);
    await abrirGerenciar(pg);
    pg.el(GES.inativas).checked = false;
    await pg.el(GES.inativas).disparar('click');
    await pg.esperar();
    b.acharEmpresa('5001').estado = 'INATIVA';
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar').disparar('click');
    await E.aguardar(pg);
    assert.equal(avisoDaGestao(pg), 'A imagem “Luva da empresa” já estava inativa.');
    assert.match(E.textoVisivel(linhaPorId(pg, '5001')), /Inativa/);
    b.acharEmpresa('5003').estado = 'ATIVA';
    await botaoDaLinha(linhaPorId(pg, '5003'), 'Reativar').disparar('click');
    await E.aguardar(pg);
    assert.equal(avisoDaGestao(pg), 'A imagem “Capacete antigo” já estava ativa.');
    assert.match(E.textoVisivel(linhaPorId(pg, '5003')), /Ativa/);
    b.acharEmpresa('5002').nome = 'Botina B';
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Renomear').disparar('click');
    await pg.esperar();
    campoDoNomeDe(pg, '5002').value = 'Botina B';
    await campoDoNomeDe(pg, '5002').disparar('input');
    await H.pressionar(campoDoNomeDe(pg, '5002'), 'Enter');
    await E.aguardar(pg);
    assert.equal(avisoDaGestao(pg), 'O nome da imagem já era “Botina B”.');
    assert.ok(linhaPorId(pg, '5002'), 'a linha mostra o nome que o servidor tem');
    assert.equal(escritas(pg).length, 3);
  });

  test('GC-10 conflito sem o código de uso (409 diferente de IMAGEM_EM_USO) e 400 fora do nome dão textos próprios e releem a lista; o 200 fora do contrato é resultado incerto, não sucesso', async () => {
    const conflito = await abrirCom(EMPRESA, { respostas: { 'POST /imagens-material/empresa/5001/inativar': () => P.erroDe(409, 'OUTRO_CONFLITO', E.TEXTO_DO_SERVIDOR) } });
    await abrirGerenciar(conflito.pg);
    let antes = leituras(conflito.pg);
    await botaoDaLinha(linhaPorId(conflito.pg, '5001'), 'Inativar').disparar('click');
    await E.aguardar(conflito.pg);
    assert.match(avisoDaGestao(conflito.pg), /por um conflito\. Atualize a lista/);
    assert.equal(leituras(conflito.pg), antes + 1);
    const invalida = await abrirCom(EMPRESA, { respostas: { 'POST /imagens-material/empresa/5001/inativar': () => P.erroDe(400, 'VALIDACAO', E.TEXTO_DO_SERVIDOR) } });
    await abrirGerenciar(invalida.pg);
    antes = leituras(invalida.pg);
    await botaoDaLinha(linhaPorId(invalida.pg, '5001'), 'Inativar').disparar('click');
    await E.aguardar(invalida.pg);
    assert.match(avisoDaGestao(invalida.pg), /O servidor não aceitou a operação/);
    assert.equal(leituras(invalida.pg), antes, '400 não relê');
    const estranha = await abrirCom(EMPRESA, { respostas: { 'POST /imagens-material/empresa/5001/inativar': () => ({ status: 200, corpo: { status: 'ok' } }) } });
    await abrirGerenciar(estranha.pg);
    antes = leituras(estranha.pg);
    await botaoDaLinha(linhaPorId(estranha.pg, '5001'), 'Inativar').disparar('click');
    await E.aguardar(estranha.pg);
    assert.doesNotMatch(avisoDaGestao(estranha.pg), /foi inativada|já estava/, 'a tela não afirma um sucesso que o servidor não confirmou');
    assert.equal(avisoDaGestao(estranha.pg), 'Não foi possível concluir a operação. Tente novamente.');
    assert.equal(leituras(estranha.pg), antes + 1, 'a lista é relida para mostrar o que o servidor tem');
    assert.match(E.textoVisivel(linhaPorId(estranha.pg, '5001')), /Ativa/);
  });

  test('GC-24 resposta 200 que não confirma a imagem pedida (sem o “excluída”, com outro id, sem “alterado”, com estado inventado) é resultado incerto: a linha não muda, não há mensagem de sucesso e a lista é relida', async () => {
    const IMG = (extra = {}) => ({ origem: 'EMPRESA', id: '5001', nome: 'Luva da empresa', versao: 1, estado: 'ATIVA', ...extra });
    const casos = [
      ['excluir sem excluida', 'DELETE /imagens-material/empresa/5001', 'EXCLUIR', { status: 'ok' }],
      ['excluir confirmando outro id', 'DELETE /imagens-material/empresa/5001', 'EXCLUIR', { status: 'ok', excluida: true, imagemId: '9999' }],
      ['renomear devolvendo outra imagem', 'PATCH /imagens-material/empresa/5001', 'RENOMEAR', { status: 'ok', alterado: true, imagem: IMG({ id: '9999' }) }],
      ['renomear sem alterado', 'PATCH /imagens-material/empresa/5001', 'RENOMEAR', { status: 'ok', imagem: IMG() }],
      ['inativar com estado inventado', 'POST /imagens-material/empresa/5001/inativar', 'INATIVAR', { status: 'ok', alterado: true, imagem: IMG({ estado: 'ESTRANHA' }) }],
      ['inativar sem nome na imagem', 'POST /imagens-material/empresa/5001/inativar', 'INATIVAR', { status: 'ok', alterado: true, imagem: IMG({ nome: undefined }) }],
    ];
    for (const [rotulo, rota, acao, corpo] of casos) {
      const { pg } = await abrirCom(EMPRESA, { respostas: { [rota]: () => ({ status: 200, corpo }) } });
      await abrirGerenciar(pg);
      const antes = leituras(pg);
      await agirSobre(pg, '5001', acao);
      assert.equal(avisoDaGestao(pg), 'Não foi possível concluir a operação. Tente novamente.', rotulo);
      assert.equal(leituras(pg), antes + 1, `${rotulo}: a lista é relida`);
      assert.equal(escritas(pg).length, 1, rotulo);
      assert.ok(linhaPorId(pg, '5001'), `${rotulo}: a linha continua`);
      assert.match(E.textoVisivel(linhaPorId(pg, '5001')), /Ativa/, rotulo);
      if (acao === 'RENOMEAR') assert.equal(campoDoNomeDe(pg, '5001')?.value, 'Nome novo', `${rotulo}: o campo continua aberto com o que foi digitado, para tentar de novo`);
      else assert.match(E.textoVisivel(linhaPorId(pg, '5001')), /Luva da empresa/, rotulo);
    }
    const semCodigo = await abrirCom(EMPRESA, { respostas: { 'POST /imagens-material/empresa/5001/inativar': () => P.erroDe(404, 'ROTA_NAO_ENCONTRADA', E.TEXTO_DO_SERVIDOR) } });
    await abrirGerenciar(semCodigo.pg);
    const antes = leituras(semCodigo.pg);
    await agirSobre(semCodigo.pg, '5001', 'INATIVAR');
    assert.equal(avisoDaGestao(semCodigo.pg), 'Não foi possível concluir a operação. Tente novamente.', '404 sem o código da imagem não é “outra pessoa excluiu”');
    assert.ok(linhaPorId(semCodigo.pg, '5001'), 'a linha não some por um 404 que não é da imagem');
    assert.equal(leituras(semCodigo.pg), antes, 'e a lista não é relida');
  });

  test('GC-25 itens da lista fora do contrato são ignorados (outra origem, estado inventado, id inválido, versão inválida, nome vazio, lixo) e um `emUso` inválido vira “desconhecido”: nada de “sem uso” inventado nem bloqueio por palpite', async () => {
    const lixo = [
      { origem: 'PADRAO', id: '31', nome: 'Padrão extra', versao: 1, estado: 'ATIVA', emUso: 0 },
      { origem: 'EMPRESA', id: '5100', nome: 'Estado estranho', versao: 1, estado: 'EXCLUIDA', emUso: 0 },
      { origem: 'EMPRESA', id: '0', nome: 'Id zero', versao: 1, estado: 'ATIVA' },
      { origem: 'EMPRESA', id: 'abc', nome: 'Id texto', versao: 1, estado: 'ATIVA' },
      { origem: 'EMPRESA', id: 5101, nome: 'Id numérico', versao: 1, estado: 'ATIVA' },
      { origem: 'EMPRESA', id: '5102', nome: '   ', versao: 1, estado: 'ATIVA' },
      { origem: 'EMPRESA', id: '5103', nome: 'Versão zero', versao: 0, estado: 'ATIVA' },
      null, 42, 'texto',
    ];
    const emUsoInvalido = { '5001': -1, '5002': 1.5, '5003': '2' };
    const adulterar = (c, regra) => {
      const r = regra(c);
      if (!leituraDaGestao(c)) return r;
      const imagens = r.corpo.imagens.map((i) => (Object.hasOwn(emUsoInvalido, i.id) ? { ...i, emUso: emUsoInvalido[i.id] } : i));
      return { ...r, corpo: { ...r.corpo, imagens: [...imagens, ...lixo] } };
    };
    const { pg } = await abrirCom([...EMPRESA, { id: '5003', nome: 'Capacete da empresa', versao: 1 }], { respostas: { 'GET /imagens-material': adulterar } });
    await abrirGerenciar(pg);
    assert.deepEqual(linhasDaGestao(pg).map((li) => li.getAttribute('data-imagem-id')).sort(), ['5001', '5002', '5003']);
    assert.match(E.normalizarTexto(pg.texto(GES.contagem)), /^3 imagens ativas · 0 inativas$/);
    for (const id of ['5001', '5002', '5003']) {
      assert.doesNotMatch(E.textoVisivel(linhaPorId(pg, id)), /Em uso|Sem uso/, `${id}: emUso inválido é desconhecido`);
      assert.equal(botaoDaLinha(linhaPorId(pg, id), 'Inativar').disabled, false, id);
    }
    assert.equal(pg.textoDoDom().includes('Padrão extra'), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-8b GC — depois de gerenciar, o seletor mostra a verdade; só a biblioteca da empresa é gerenciável', () => {
  test('GC-11 “Concluir” sem operação não relê o seletor; depois de renomear, inativar, reativar e excluir ele é relido UMA vez e mostra nome novo, inativa fora, reativada de volta e excluída fora', async () => {
    const { pg } = await abrirCom([...EMPRESA, { id: '5003', nome: 'Capacete antigo', versao: 1, estado: 'INATIVA' }, { id: '5004', nome: 'Óculos da empresa', versao: 1 }]);
    await H.abrirSeletor(pg);
    await E.irParaAba(pg, 'Minha Empresa');
    assert.deepEqual(E.pares(pg), ['EMPRESA:5002', 'EMPRESA:5001', 'EMPRESA:5004'], 'o seletor só oferece as ativas');
    let n = leituras(pg);
    await botaoGerenciar(pg).disparar('click');
    await E.aguardar(pg);
    await pg.el(GES.concluir).disparar('click');
    await E.aguardar(pg);
    assert.equal(leituras(pg), n + 1, 'só a leitura do próprio modo: ao voltar sem alterar nada o seletor não é lido de novo');
    n = leituras(pg);
    await botaoGerenciar(pg).disparar('click');
    await E.aguardar(pg);
    pg.el(GES.inativas).checked = false;
    await pg.el(GES.inativas).disparar('click');
    await pg.esperar();
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear').disparar('click');
    await pg.esperar();
    campoDoNomeDe(pg, '5001').value = 'Avental';
    await campoDoNomeDe(pg, '5001').disparar('input');
    await H.pressionar(campoDoNomeDe(pg, '5001'), 'Enter');
    await E.aguardar(pg);
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Inativar').disparar('click');
    await E.aguardar(pg);
    await botaoDaLinha(linhaPorId(pg, '5003'), 'Reativar').disparar('click');
    await E.aguardar(pg);
    await botaoDaLinha(linhaPorId(pg, '5004'), 'Excluir').disparar('click');
    await pg.esperar();
    await botaoDaLinha(linhaPorId(pg, '5004'), 'Excluir imagem').disparar('click');
    await E.aguardar(pg);
    assert.equal(escritas(pg).length, 4);
    const antes = leituras(pg);
    await pg.el(GES.concluir).disparar('click');
    await E.aguardar(pg);
    assert.equal(leituras(pg), antes + 1, 'uma leitura do seletor');
    assert.ok(n < antes);
    assert.equal(pg.visivelNo(pg.el('imagemVistaBiblioteca')), true);
    assert.deepEqual(E.abasAtivas(pg), ['Minha Empresa'], 'continua na aba Minha Empresa');
    assert.deepEqual(E.pares(pg), ['EMPRESA:5001', 'EMPRESA:5003'], 'Avental (5001) e Capacete antigo (5003); a Botina inativa e os Óculos excluídos saíram');
    assert.match(E.textoVisivel(H.itens(pg)[0]), /Avental/);
    const consulta = E.consultaDaChamada(E.chamadasDaLista(pg).at(-1));
    assert.equal(consulta.estado ?? 'ATIVA', 'ATIVA');
  });

  test('GC-12 a imagem marcada no seletor (rascunho) que some ao gerenciar não pode mais ser confirmada, a escolha já confirmada no formulário não é perdida e o renomear atualiza o nome mostrado', async () => {
    const { pg } = await abrirCom();
    await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
    assert.match(pg.texto('imagemMaterialEstado'), /Luva da empresa/);
    await H.abrirSeletor(pg);
    await E.irParaAba(pg, 'Minha Empresa');
    await H.itens(pg).find((e) => E.par(e) === 'EMPRESA:5002').disparar('click');
    assert.deepEqual(E.paresMarcados(pg), ['EMPRESA:5002']);
    await botaoGerenciar(pg).disparar('click');
    await E.aguardar(pg);
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear').disparar('click');
    await pg.esperar();
    campoDoNomeDe(pg, '5001').value = 'Luva reforçada';
    await campoDoNomeDe(pg, '5001').disparar('input');
    await H.pressionar(campoDoNomeDe(pg, '5001'), 'Enter');
    await E.aguardar(pg);
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Excluir').disparar('click');
    await pg.esperar();
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Excluir imagem').disparar('click');
    await E.aguardar(pg);
    await pg.el(GES.concluir).disparar('click');
    await E.aguardar(pg);
    assert.deepEqual(E.pares(pg), ['EMPRESA:5001']);
    assert.deepEqual(E.paresMarcados(pg), [], 'a marca da imagem excluída não sobra');
    assert.equal(pg.el(IDS.confirmar).disabled, true, 'nada a confirmar');
    await pg.clicar(IDS.cancelar);
    assert.match(pg.texto('imagemMaterialEstado'), /Luva reforçada/, 'a escolha do formulário continua, com o nome novo');
    assert.equal(pg.textoDoDom().includes('Luva da empresa'), false);
  });

  test('GC-13 só a biblioteca da empresa: a lista do modo é pedida com origem=EMPRESA, nenhuma imagem padrão aparece e toda escrita vai a /imagens-material/empresa/:id', async () => {
    const { pg } = await abrirCom([...EMPRESA, { id: '5003', nome: 'Capacete antigo', versao: 1, estado: 'INATIVA' }]);
    await abrirGerenciar(pg);
    const consulta = E.consultaDaChamada(E.chamadasDaLista(pg).at(-1));
    assert.equal(consulta.origem, 'EMPRESA');
    assert.equal(linhasDaGestao(pg).length, 2);
    assert.equal(pg.el(GES.vista).querySelectorAll('[data-imagem-origem="PADRAO"]').length, 0);
    assert.equal(pg.el(GES.vista).querySelectorAll('li').every((li) => li.getAttribute('data-imagem-origem') === 'EMPRESA'), true);
    pg.el(GES.inativas).checked = false;
    await pg.el(GES.inativas).disparar('click');
    await pg.esperar();
    await botaoDaLinha(linhaPorId(pg, '5003'), 'Reativar').disparar('click');
    await E.aguardar(pg);
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar').disparar('click');
    await E.aguardar(pg);
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Renomear').disparar('click');
    await pg.esperar();
    campoDoNomeDe(pg, '5002').value = 'Botina nova';
    await campoDoNomeDe(pg, '5002').disparar('input');
    await H.pressionar(campoDoNomeDe(pg, '5002'), 'Enter');
    await E.aguardar(pg);
    await botaoDaLinha(linhaPorId(pg, '5003'), 'Excluir').disparar('click');
    await pg.esperar();
    await botaoDaLinha(linhaPorId(pg, '5003'), 'Excluir imagem').disparar('click');
    await E.aguardar(pg);
    assert.equal(escritas(pg).length, 4);
    for (const c of escritas(pg)) assert.match(c.caminho, /^\/imagens-material\/empresa\/\d+(\/(inativar|reativar))?$/, `${c.metodo} ${c.caminho}`);
    assert.deepEqual(escritas(pg).map((c) => c.metodo), ['POST', 'POST', 'PATCH', 'DELETE']);
  });

  test('GC-14 mais de 100 imagens: a lista do modo lê página por página (limite 100) e mostra todas; uma página que falha deixa a lista parcial com aviso e “Atualizar lista” completa', async () => {
    let falharSegunda = true;
    const { pg } = await abrirCom(E.empresaN(150), {
      respostas: { 'GET /imagens-material': (c, regra) => (falharSegunda && leituraDaGestao(c) && new URL(c.url).searchParams.get('pagina') === '2' ? P.erroDe(503, 'IMAGENS_INDISPONIVEL', E.TEXTO_DO_SERVIDOR) : regra(c)) },
    });
    await abrirGerenciar(pg);
    const paginas = E.chamadasDaLista(pg).filter(leituraDaGestao).map((c) => E.consultaDaChamada(c));
    assert.deepEqual(paginas.map((q) => [q.pagina, q.limite]), [['1', '100'], ['2', '100']]);
    assert.equal(linhasDaGestao(pg).length, 100, 'o que veio continua à vista');
    assert.match(estadoDaGestao(pg), /A lista pode estar incompleta/);
    assert.match(E.normalizarTexto(pg.texto(GES.contagem)), /100 imagens ativas/);
    falharSegunda = false;
    await pg.el(GES.atualizar).disparar('click');
    await E.aguardar(pg);
    assert.equal(linhasDaGestao(pg).length, 150);
    assert.equal(estadoDaGestao(pg), '');
    assert.match(E.normalizarTexto(pg.texto(GES.contagem)), /150 imagens ativas · 0 inativas/);
  });

  test('GC-15 contrato sem `emUso`: a tela não inventa “sem uso” nem bloqueia por palpite — mostra só o estado, deixa os botões habilitados e o 409 do servidor decide', async () => {
    const semUso = (c, regra) => {
      const r = regra(c);
      return leituraDaGestao(c) ? { ...r, corpo: { ...r.corpo, imagens: r.corpo.imagens.map(({ emUso, ...resto }) => resto) } } : r;
    };
    const { pg, b } = await abrirCom(EMPRESA, {
      outros: [{ id: 701, nome: 'Fita isolante', imagem: { origem: 'EMPRESA', id: '5001', versao: 1, nome: 'x' } }], respostas: { 'GET /imagens-material': semUso },
    });
    await abrirGerenciar(pg);
    for (const id of ['5001', '5002']) {
      assert.doesNotMatch(E.textoVisivel(linhaPorId(pg, id)), /Em uso|Sem uso/, id);
      for (const verbo of ['Renomear', 'Inativar', 'Excluir']) assert.equal(botaoDaLinha(linhaPorId(pg, id), verbo).disabled, false, `${id} ${verbo}`);
    }
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar').disparar('click');
    await E.aguardar(pg);
    assert.match(avisoDaGestao(pg), /está em uso por material/);
    assert.equal(b.acharEmpresa('5001').estado, 'ATIVA');
    assert.equal(escritas(pg).length, 1);
  });

  test('GC-26 escolha pendente: só a imagem DA EMPRESA com o mesmo id é marcada (a Padrão de mesmo número não confunde); a confirmação de exclusão repete o aviso, o resultado também, e a escolha do formulário não se perde', async () => {
    const { pg } = await abrirCom([{ id: '1001', nome: 'Luva da empresa', versao: 1 }, { id: '5002', nome: 'Botina antiga da empresa', versao: 3 }]);
    await E.escolherNoSeletor(pg, 'PADRAO', '1001');
    await abrirGerenciar(pg);
    assert.doesNotMatch(E.textoVisivel(linhaPorId(pg, '1001')), /Escolhida no formulário/, 'PADRAO:1001 não é EMPRESA:1001');
    await pg.el(GES.concluir).disparar('click');
    await E.aguardar(pg);
    await H.itens(pg).find((e) => E.par(e) === 'EMPRESA:1001').disparar('click');
    await H.confirmar(pg);
    await pg.esperar();
    assert.match(pg.texto('imagemMaterialEstado'), /Luva da empresa/);
    await abrirGerenciar(pg);
    assert.match(E.textoVisivel(linhaPorId(pg, '1001')), /Escolhida no formulário, ainda não salva/);
    assert.doesNotMatch(E.textoVisivel(linhaPorId(pg, '5002')), /Escolhida no formulário/);
    await botaoDaLinha(linhaPorId(pg, '1001'), 'Excluir').disparar('click');
    await pg.esperar();
    const AVISO = 'Ela está escolhida no formulário e ainda não foi salva: ao salvar o material o servidor a recusará. Escolha outra imagem ou remova a seleção.';
    assert.ok(E.normalizarTexto(E.textoVisivel(linhaPorId(pg, '1001'))).includes(AVISO), 'a confirmação lembra da escolha pendente');
    await botaoDaLinha(linhaPorId(pg, '1001'), 'Excluir imagem').disparar('click');
    await E.aguardar(pg);
    assert.equal(avisoDaGestao(pg), `A imagem “Luva da empresa” foi excluída. A vaga voltou para a cota. ${AVISO}`);
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Inativar').disparar('click');
    await E.aguardar(pg);
    assert.equal(avisoDaGestao(pg), 'A imagem “Botina antiga da empresa” foi inativada. Ela saiu do seletor, mas continua ocupando uma vaga da cota.', 'sem escolha pendente o aviso não leva o lembrete');
    await pg.el(GES.concluir).disparar('click');
    await E.aguardar(pg);
    await pg.clicar(IDS.cancelar);
    assert.match(pg.texto('imagemMaterialEstado'), /Luva da empresa/, 'a escolha pendente continua no formulário');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-8b GC — detalhes de interface: reativar, estados vazios e o campo do nome', () => {
  test('GC-27 reativar também dispara uma vez só e a linha diz “Reativando…” enquanto espera', async () => {
    const pausa = segurarRota();
    const { pg, b } = await abrirCom([...EMPRESA, { id: '5003', nome: 'Capacete antigo', versao: 1, estado: 'INATIVA' }], { respostas: { 'POST /imagens-material/empresa/5003/reativar': seguradaEm(pausa) } });
    await abrirGerenciar(pg);
    pg.el(GES.inativas).checked = false;
    await pg.el(GES.inativas).disparar('click');
    await pg.esperar();
    const botao = botaoDaLinha(linhaPorId(pg, '5003'), 'Reativar');
    assert.equal(botao.disabled, false, 'reativar nunca é bloqueado');
    await Promise.all([botao.disparar('click'), botao.disparar('click')]);
    await pg.esperar();
    await botao.disparar('click');
    await pg.esperar();
    assert.deepEqual(escritas(pg).map((c) => `${c.metodo} ${c.caminho}`), ['POST /imagens-material/empresa/5003/reativar']);
    assert.match(E.textoVisivel(linhaPorId(pg, '5003')), /Reativando…/);
    assert.equal(pg.el(GES.inativas).disabled, true, 'o filtro também fica travado');
    pausa.liberar();
    await E.aguardar(pg);
    assert.equal(b.acharEmpresa('5003').estado, 'ATIVA');
    assert.match(avisoDaGestao(pg), /foi reativada e voltou ao seletor/);
    assert.equal(pg.el(GES.aviso).getAttribute('class').includes('bi-aviso-erro'), false, 'sucesso não usa o estilo de erro');
  });

  test('GC-28 estados vazios: empresa sem imagens e empresa só com imagens inativas dizem o que acontece e como ver as inativas', async () => {
    const vazia = await abrirCom([]);
    await abrirGerenciar(vazia.pg);
    assert.equal(estadoDaGestao(vazia.pg), 'Sua empresa ainda não tem imagens.');
    assert.match(E.normalizarTexto(vazia.pg.texto(GES.contagem)), /^0 imagens ativas · 0 inativas$/);
    assert.equal(linhasDaGestao(vazia.pg).length, 0);
    const soInativas = await abrirCom([{ id: '5003', nome: 'Capacete antigo', versao: 1, estado: 'INATIVA' }]);
    await abrirGerenciar(soInativas.pg);
    assert.match(estadoDaGestao(soInativas.pg), /^Nenhuma imagem ativa\. Use “Mostrar inativas” para ver e reativar as imagens inativas\.$/);
    assert.match(E.normalizarTexto(soInativas.pg.texto(GES.contagem)), /^0 imagens ativas · 1 inativa \(oculta\)$/);
    soInativas.pg.el(GES.inativas).checked = false;
    await soInativas.pg.el(GES.inativas).disparar('click');
    await soInativas.pg.esperar();
    assert.equal(estadoDaGestao(soInativas.pg), '');
    assert.equal(linhasDaGestao(soInativas.pg).length, 1);
    assert.match(E.normalizarTexto(soInativas.pg.texto(GES.contagem)), /^0 imagens ativas · 1 inativa$/);
  });

  test('GC-29 renomear: o campo vai até 100 caracteres e se anuncia pelo nome da imagem; digitar limpa o erro; “Cancelar” descarta o texto e devolve o foco; a ordem acompanha o nome novo (com acento); Escape sem nada aberto fecha o pop-up', async () => {
    const { pg } = await abrirCom([{ id: '5001', nome: 'Luva da empresa', versao: 1 }, { id: '5002', nome: 'Botina antiga da empresa', versao: 3 }, { id: '5003', nome: 'Zebra', versao: 1 }]);
    await abrirGerenciar(pg);
    const ordem = () => linhasDaGestao(pg).map((li) => li.getAttribute('data-imagem-id'));
    assert.deepEqual(ordem(), ['5002', '5001', '5003']);
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear').disparar('click');
    await pg.esperar();
    const campo = () => campoDoNomeDe(pg, '5001');
    assert.equal(campo().getAttribute('maxlength'), '100');
    assert.equal(campo().getAttribute('aria-label'), 'Novo nome da imagem Luva da empresa');
    campo().value = '';
    await campo().disparar('input');
    await H.pressionar(campo(), 'Enter');
    await pg.esperar();
    assert.match(E.textoVisivel(linhaPorId(pg, '5001')), /Informe um nome de 1 a 100 caracteres/);
    campo().value = 'a';
    await campo().disparar('input');
    assert.doesNotMatch(E.textoVisivel(linhaPorId(pg, '5001')), /Informe um nome/, 'digitar limpa o erro');
    campo().value = 'Texto que será descartado';
    await campo().disparar('input');
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Cancelar').disparar('click');
    await pg.esperar();
    nulo(campo(), 'o campo fecha');
    assert.match(E.textoVisivel(linhaPorId(pg, '5001')), /Luva da empresa/);
    mesmo(pg.documento.activeElement, botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear'), 'cancelar devolve o foco a quem abriu');
    assert.equal(escritas(pg).length, 0);
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Renomear').disparar('click');
    await pg.esperar();
    campoDoNomeDe(pg, '5002').value = 'Óculos de proteção';
    await campoDoNomeDe(pg, '5002').disparar('input');
    await H.pressionar(campoDoNomeDe(pg, '5002'), 'Enter');
    await E.aguardar(pg);
    assert.deepEqual(ordem(), ['5001', '5002', '5003'], '“Óculos” fica entre “Luva” e “Zebra”, como a ordem do servidor');
    mesmo(pg.documento.activeElement, botaoDaLinha(linhaPorId(pg, '5002'), 'Renomear'), 'o foco acompanha a linha que mudou de lugar');
    await H.pressionar(pg.el(GES.lista), 'Escape');
    await pg.esperar();
    assert.equal(E.modal(pg).getAttribute('aria-hidden'), 'true', 'sem edição nem confirmação abertas, Escape fecha o pop-up');
    mesmo(pg.documento.activeElement, pg.el(IDS.escolher), 'Escape devolve o foco ao campo da imagem');
  });

  test('GC-34 nomes hostis (HTML, script, entidades) viram TEXTO na lista, nos rótulos, na confirmação e no campo de renomear: nenhum elemento nasce deles e nada executa', async () => {
    const hostis = ['<b>negrito</b>', '"><script>window.__xss = 1</script>', '<img src=x onerror="window.__xss = 2">', '&amp; &lt;i&gt;'];
    const { pg } = await abrirCom(hostis.map((nome, i) => ({ id: String(5001 + i), nome, versao: 1 })));
    await abrirGerenciar(pg);
    assert.equal(linhasDaGestao(pg).length, 4);
    assert.equal(pg.el(GES.lista).querySelectorAll('b, i, script').length, 0, 'nenhuma tag nasceu de um nome');
    assert.equal(pg.el(GES.lista).querySelectorAll('img').length, 4, 'só as quatro miniaturas');
    for (const [i, nome] of hostis.entries()) {
      const linha = linhaPorId(pg, String(5001 + i));
      assert.ok(E.textoVisivel(linha).includes(nome), nome);
      assert.equal(botaoDaLinha(linha, 'Renomear').getAttribute('aria-label'), `Renomear ${nome}`);
    }
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Excluir').disparar('click');
    await pg.esperar();
    const painel = linhaPorId(pg, '5002').querySelectorAll('div').find((d) => d.getAttribute('role') === 'group');
    assert.equal(painel.getAttribute('aria-label'), `Confirmar a exclusão de ${hostis[1]}`);
    assert.ok(E.textoVisivel(painel).includes(`Excluir “${hostis[1]}”?`));
    assert.equal(painel.querySelectorAll('script, b, i').length, 0);
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Cancelar').disparar('click');
    await pg.esperar();
    await botaoDaLinha(linhaPorId(pg, '5003'), 'Renomear').disparar('click');
    await pg.esperar();
    assert.equal(campoDoNomeDe(pg, '5003').value, hostis[2], 'o campo traz o nome como valor');
    assert.equal(pg.el(GES.lista).querySelectorAll('script, b, i').length, 0);
    assert.equal(pg.janela.__xss, undefined, 'nada executou');
    assert.equal(escritas(pg).length, 0);
  });

  test('GC-33 o nome vale até 100 PONTOS DE CÓDIGO depois do NFC (100 letras, 100 emojis e 100 “é” decompostos passam; 101 não vai ao servidor)', async () => {
    const { pg, b } = await abrirCom();
    await abrirGerenciar(pg);
    const renomear = async (digitado) => {
      await botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear').disparar('click');
      await pg.esperar();
      campoDoNomeDe(pg, '5001').value = digitado;
      await campoDoNomeDe(pg, '5001').disparar('input');
      await H.pressionar(campoDoNomeDe(pg, '5001'), 'Enter');
      await E.aguardar(pg);
    };
    const casos = [
      ['100 letras', 'ç'.repeat(100), 'ç'.repeat(100)],
      ['100 emojis (200 unidades UTF-16)', '😀'.repeat(100), '😀'.repeat(100)],
      ['100 “é” decompostos (200 pontos antes do NFC)', 'é'.repeat(100), 'é'.repeat(100)],
    ];
    for (const [rotulo, digitado, esperado] of casos) {
      await renomear(digitado);
      const ultima = escritas(pg).at(-1);
      assert.deepEqual([ultima.metodo, ultima.caminho, ultima.corpo], ['PATCH', '/imagens-material/empresa/5001', { nome: esperado }], rotulo);
      assert.equal(b.acharEmpresa('5001').nome, esperado, rotulo);
    }
    const antes = escritas(pg).length;
    await renomear('ç'.repeat(101));
    assert.equal(escritas(pg).length, antes, '101 pontos de código nunca vão ao servidor');
    assert.match(E.textoVisivel(linhaPorId(pg, '5001')), /Informe um nome de 1 a 100 caracteres/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-8b GC — releitura da lista depois de um erro: botões antigos, uma edição por vez, resposta antiga e foco', () => {
  const usadaPorOutro = (b, idImagem) => b.materiais.set(704, { ...b.materiais.get(501), id: 704, nome: 'Outro material', imagem: { origem: 'EMPRESA', id: idImagem, versao: 1, nome: 'x' } });

  test('GC-30 enquanto a lista é relida depois de um conflito, os botões antigos não disparam nada; e só uma edição fica aberta por vez (renomear fecha a confirmação e a confirmação fecha o renomear)', async () => {
    const pausa = segurarRota();
    let leiturasDoModo = 0;
    const { pg, b } = await abrirCom([...EMPRESA, { id: '5003', nome: 'Capacete da empresa', versao: 1 }], {
      respostas: { 'GET /imagens-material': seguradaEm(pausa, (c) => leituraDaGestao(c) && (leiturasDoModo += 1) === 2) },
    });
    await abrirGerenciar(pg);
    const antigos = ['Renomear', 'Inativar', 'Excluir'].map((verbo) => botaoDaLinha(linhaPorId(pg, '5002'), verbo));
    usadaPorOutro(b, '5001');
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar').disparar('click');
    await pg.esperar();
    assert.match(estadoDaGestao(pg), /Carregando as imagens da empresa…/, 'a releitura está presa');
    const antes = escritas(pg).length;
    for (const antigo of antigos) await antigo.disparar('click');
    await pg.esperar();
    assert.equal(escritas(pg).length, antes, 'nenhuma requisição saiu pelos botões antigos');
    assert.equal(pg.el(GES.lista).querySelectorAll('input').filter((i) => i.type === 'text').length, 0, 'nenhum campo de nome abriu');
    assert.equal(pg.el(GES.lista).querySelectorAll('[role="group"]').length, 0, 'nenhuma confirmação abriu');
    pausa.liberar();
    await E.aguardar(pg);
    assert.equal(estadoDaGestao(pg), '');
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Renomear').disparar('click');
    await pg.esperar();
    assert.ok(campoDoNomeDe(pg, '5002'), 'o campo de nome abriu');
    await botaoDaLinha(linhaPorId(pg, '5003'), 'Excluir').disparar('click');
    await pg.esperar();
    nulo(campoDoNomeDe(pg, '5002'), 'abrir a confirmação fecha o renomear');
    assert.equal(linhaPorId(pg, '5003').querySelectorAll('[role="group"]').length, 1);
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Renomear').disparar('click');
    await pg.esperar();
    assert.equal(linhaPorId(pg, '5003').querySelectorAll('[role="group"]').length, 0, 'abrir o renomear fecha a confirmação');
    assert.ok(campoDoNomeDe(pg, '5002'));
    assert.equal(escritas(pg).length, antes);
  });

  test('GC-31 a resposta antiga da lista nunca sobrescreve a nova: sair e entrar de novo com a primeira leitura presa e liberá-la depois mantém o que a segunda trouxe', async () => {
    const pausa = segurarRota();
    let n = 0;
    const congelada = async (c, regra) => {
      if (!leituraDaGestao(c)) return regra(c);
      n += 1;
      const r = regra(c); // o instantâneo é tirado na hora do pedido; só a entrega é presa
      if (n === 1) await pausa.espera;
      return r;
    };
    const { pg, b } = await abrirCom(EMPRESA, { respostas: { 'GET /imagens-material': congelada } });
    await H.abrirSeletor(pg);
    await E.irParaAba(pg, 'Minha Empresa');
    const primeira = botaoGerenciar(pg).disparar('click');
    await E.aguardar(pg);
    await pg.el(GES.concluir).disparar('click');
    await pg.esperar();
    b.acharEmpresa('5001').nome = 'Luva B';
    await botaoGerenciar(pg).disparar('click');
    await E.aguardar(pg);
    assert.match(E.textoVisivel(linhaPorId(pg, '5001')), /Luva B/);
    pausa.liberar();
    await primeira;
    await E.aguardar(pg);
    assert.match(E.textoVisivel(linhaPorId(pg, '5001')), /Luva B/, 'a resposta antiga (Luva da empresa) não sobrescreve a nova');
    assert.equal(linhasDaGestao(pg).length, 2);
    assert.equal(estadoDaGestao(pg), '');
  });

  test('GC-32 depois de um erro que faz reler a lista (404, 409, 500, rede) o foco fica num controle do pop-up — o da própria linha se ela continua utilizável, senão o da vizinha —, nunca solto no corpo da página', async () => {
    const casos = [
      ['500', { respostas: { 'POST /imagens-material/empresa/5001/inativar': () => P.erroDe(500, 'ERRO_INTERNO', E.TEXTO_DO_SERVIDOR) } }, () => {}, 'Inativar', '5001'],
      ['rede', { respostas: { 'POST /imagens-material/empresa/5001/inativar': () => new Error('rede') } }, () => {}, 'Inativar', '5001'],
      ['409 (passou a ser usada: o Inativar dela ficou desabilitado)', {}, (b) => usadaPorOutro(b, '5001'), 'Renomear', '5002'],
      ['404 (outra pessoa excluiu)', {}, (b) => { b.empresa = b.empresa.filter((i) => i.id !== '5001'); }, 'Renomear', '5002'],
    ];
    for (const [rotulo, extra, preparar, verboEsperado, linhaEsperada] of casos) {
      const { pg, b } = await abrirCom(EMPRESA, extra);
      await abrirGerenciar(pg);
      preparar(b);
      await botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar').disparar('click');
      await E.aguardar(pg);
      const ativo = pg.documento.activeElement;
      assert.ok(ativo && E.modal(pg).contains(ativo), `${rotulo}: o foco está dentro do pop-up`);
      mesmo(ativo, botaoDaLinha(linhaPorId(pg, linhaEsperada), verboEsperado), `${rotulo}: o foco está no ${verboEsperado} da linha ${linhaEsperada}`);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-8b GC — foco e leitura por tecnologia assistiva na entrada, na saída e no diálogo', () => {
  test('GC-16 entrar leva o foco ao título da vista e o diálogo passa a ser rotulado por ele; “Concluir” devolve o foco ao “Gerenciar imagens” e o rótulo do diálogo volta ao título da biblioteca', async () => {
    const { pg } = await abrirCom();
    await H.abrirSeletor(pg);
    await E.irParaAba(pg, 'Minha Empresa');
    const dialogo = pg.consulta('#modalImagemMaterial [role="dialog"]')[0];
    assert.equal(dialogo.getAttribute('aria-labelledby'), 'imagemModalTitulo');
    await botaoGerenciar(pg).disparar('click');
    await E.aguardar(pg);
    mesmo(pg.documento.activeElement, pg.el(GES.titulo), 'entrar leva o foco ao título da vista');
    assert.equal(dialogo.getAttribute('aria-labelledby'), 'imagemGestaoTitulo');
    assert.equal(dialogo.getAttribute('aria-describedby'), 'imagemGestaoDescricao');
    assert.equal(pg.el(GES.titulo).getAttribute('tabindex'), '-1');
    for (const id of [GES.contagem, GES.aviso, GES.estado]) assert.equal(pg.el(id).getAttribute('aria-live'), 'polite', id);
    assert.equal(pg.el(GES.lista).getAttribute('aria-label'), 'Imagens da biblioteca da empresa');
    for (const li of linhasDaGestao(pg)) {
      for (const x of li.querySelectorAll('button')) assert.match(E.nomeAcessivel(x), /^(Renomear|Inativar|Excluir) .+/, 'cada botão diz o que faz e em qual imagem');
    }
    await pg.el(GES.concluir).disparar('click');
    await pg.esperar();
    mesmo(pg.documento.activeElement, botaoGerenciar(pg), 'Concluir devolve o foco ao “Gerenciar imagens”');
    assert.equal(dialogo.getAttribute('aria-labelledby'), 'imagemModalTitulo');
  });

  test('GC-17 depois de um erro o foco volta ao controle que agiu; o “X” da vista fecha o pop-up inteiro e reabrir começa na biblioteca, sem nada da visita anterior', async () => {
    const { pg } = await abrirCom(EMPRESA, { respostas: { 'POST /imagens-material/empresa/5001/inativar': () => P.erroDe(429, 'LIMITE_REQUISICOES_EXCEDIDO', E.TEXTO_DO_SERVIDOR) } });
    await abrirGerenciar(pg);
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar').disparar('click');
    await E.aguardar(pg);
    assert.match(avisoDaGestao(pg), /Muitas operações em pouco tempo/);
    mesmo(pg.documento.activeElement, botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar'), 'o foco volta ao controle que agiu');
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Excluir').disparar('click');
    await pg.esperar();
    await pg.el(GES.fechar).disparar('click');
    await pg.esperar();
    assert.equal(E.modal(pg).getAttribute('aria-hidden'), 'true');
    mesmo(pg.documento.activeElement, pg.el(IDS.escolher), 'o foco volta ao campo da imagem');
    await H.abrirSeletor(pg);
    assert.equal(pg.visivelNo(pg.el('imagemVistaBiblioteca')), true);
    assert.equal(pg.visivelNo(pg.el(GES.vista)), false);
    await E.irParaAba(pg, 'Minha Empresa');
    await botaoGerenciar(pg).disparar('click');
    await E.aguardar(pg);
    assert.equal(avisoDaGestao(pg), '', 'o aviso da visita anterior não sobra');
    assert.equal(pg.el(GES.vista).querySelectorAll('[role="group"]').length, 0, 'nenhuma confirmação pendente sobra');
    assert.equal(pg.el(GES.inativas).checked, false);
  });
});

// ─────────────────────────────────────────────────────────────────────
// O módulo sozinho numa página mínima (como em imagens-material-empresa-envio-complemento.test.js): dá acesso à API (habilitar, encerrar).
const paginaMinima = `<html><head></head><body>
  <div id="campoImagemMaterial"><div id="imagemMaterialPrevia"></div><div id="imagemMaterialEstado" role="status"></div>
    <button id="botaoRemoverImagem" type="button" hidden></button><button id="botaoEscolherImagem" type="button">Escolher imagem</button></div>
  <script src="../js/api-http.js"></script>
  <script src="../js/imagens-material.js"></script>
</body></html>`;

async function abrirMinima({ empresa = EMPRESA, respostas = {} } = {}) {
  const sv = E.servidor({ biblioteca: E.criarBiblioteca({ empresa, proximoId: 6001 }), respostas });
  const pg = abrirPagina('pages/materials.html', { html: paginaMinima, rotas: sv.rotas });
  await pg.esperar();
  const api = pg.janela.EpiImagensMaterial.montar({ documento: pg.documento, aoSessaoEncerrada: () => { pg.janela.sessaoFoiEncerrada = true; } });
  return { pg, api, b: sv.biblioteca };
}

describe('5C-8b GC — permissão e sessão que mudam com o pop-up aberto (módulo isolado)', () => {
  test('GC-18 o botão “Gerenciar imagens” só existe com gerenciar === true (estrito: enviar, texto, número ou ausência não bastam) e some do DOM quando a permissão sai', async () => {
    const { pg, api } = await abrirMinima();
    for (const permissoes of [undefined, {}, { enviar: true }, { gerenciar: 'true' }, { gerenciar: 1 }, { gerenciar: false }]) {
      api.habilitar(true, permissoes);
      await H.abrirSeletor(pg);
      await E.irParaAba(pg, 'Minha Empresa');
      nulo(botaoGerenciar(pg), JSON.stringify(permissoes));
      assert.equal(E.nomesDosBotoes(E.modal(pg)).some((nome) => /Gerenciar/.test(nome)), false, JSON.stringify(permissoes));
      api.fechar();
    }
    api.habilitar(true, { gerenciar: true });
    await H.abrirSeletor(pg);
    assert.equal(E.acionavel(pg, botaoGerenciar(pg)), false, 'na aba Todas não aparece');
    await E.irParaAba(pg, 'Minha Empresa');
    assert.equal(E.acionavel(pg, botaoGerenciar(pg)), true);
    api.habilitar(true, { gerenciar: false });
    nulo(botaoGerenciar(pg), 'a permissão saiu: o botão sai do DOM');
  });

  test('GC-19 a permissão de gerenciar some com o modo aberto e nada em andamento: a tela volta à biblioteca, sem o botão; sem permissão nenhuma o pop-up fecha e reabre na biblioteca', async () => {
    const { pg, api } = await abrirMinima();
    api.habilitar(true, { gerenciar: true });
    await abrirGerenciar(pg);
    assert.equal(pg.visivelNo(pg.el(GES.vista)), true);
    api.habilitar(true, { gerenciar: false });
    await pg.esperar();
    assert.equal(pg.visivelNo(pg.el(GES.vista)), false);
    assert.equal(pg.visivelNo(pg.el('imagemVistaBiblioteca')), true);
    nulo(botaoGerenciar(pg), 'sem a permissão o botão não existe');
    assert.equal(linhasDaGestao(pg).length, 0, 'nada da visita anterior sobra');
    api.habilitar(true, { gerenciar: true });
    await abrirGerenciar(pg).catch(() => undefined);
    await pg.esperar();
    api.habilitar(false);
    assert.equal(E.modal(pg).getAttribute('aria-hidden'), 'true');
    api.habilitar(true, { gerenciar: true });
    await H.abrirSeletor(pg);
    assert.equal(pg.visivelNo(pg.el('imagemVistaBiblioteca')), true);
    assert.equal(pg.visivelNo(pg.el(GES.vista)), false);
  });

  test('GC-20 a permissão sai com uma operação em andamento: o pop-up fecha, a resposta tardia não escreve na tela nem chama o Portal, e a próxima abertura mostra o que o servidor tem', async () => {
    const pausa = segurarRota();
    const { pg, api, b } = await abrirMinima({ respostas: { 'POST /imagens-material/empresa/5001/inativar': seguradaEm(pausa) } });
    api.habilitar(true, { gerenciar: true });
    await abrirGerenciar(pg);
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar').disparar('click');
    await pg.esperar();
    api.habilitar(false);
    pausa.liberar();
    await E.aguardar(pg);
    assert.equal(E.modal(pg).getAttribute('aria-hidden'), 'true');
    assert.equal(linhasDaGestao(pg).length, 0);
    assert.equal(avisoDaGestao(pg), '', 'a resposta tardia não escreve na tela');
    assert.equal(pg.janela.sessaoFoiEncerrada, undefined);
    assert.equal(b.acharEmpresa('5001').estado, 'INATIVA', 'o servidor aplicou a operação');
    api.habilitar(true, { gerenciar: true });
    await H.abrirSeletor(pg);
    await E.aguardar(pg);
    await E.irParaAba(pg, 'Minha Empresa');
    assert.deepEqual(E.pares(pg), ['EMPRESA:5002'], 'a lista foi lida de novo: a imagem inativada não é mais oferecida');
  });

  test('GC-21 sessão encerrada (encerrar) com uma operação em andamento: a resposta tardia não escreve nada, não chama o Portal e o pop-up reabre na biblioteca com a lista relida', async () => {
    const pausa = segurarRota();
    const { pg, api } = await abrirMinima({ respostas: { 'DELETE /imagens-material/empresa/5002': seguradaEm(pausa) } });
    api.habilitar(true, { gerenciar: true });
    await abrirGerenciar(pg);
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Excluir').disparar('click');
    await pg.esperar();
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Excluir imagem').disparar('click');
    await pg.esperar();
    api.encerrar();
    pausa.liberar();
    await E.aguardar(pg);
    assert.equal(E.modal(pg).getAttribute('aria-hidden'), 'true');
    assert.equal(linhasDaGestao(pg).length, 0);
    assert.equal(avisoDaGestao(pg), '');
    assert.equal(pg.janela.sessaoFoiEncerrada, undefined);
    await H.abrirSeletor(pg);
    await E.aguardar(pg);
    assert.equal(pg.visivelNo(pg.el('imagemVistaBiblioteca')), true);
    await E.irParaAba(pg, 'Minha Empresa');
    assert.deepEqual(E.pares(pg), ['EMPRESA:5001']);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-8b GC — as mensagens de limite e de indisponibilidade do envio aparecem uma vez só', () => {
  const foto = (n) => E.arquivo({ nome: `foto-${n}.png`, tipo: 'image/png', semente: `gc-${n}` });
  const ocorrencias = (texto, trecho) => texto.split(trecho).length - 1;

  const cenarios = [
    ['429', () => E.erroDeEnvio(429, 'LIMITE_REQUISICOES_EXCEDIDO', { cabecalhos: { 'Retry-After': '30' } }), 'Muitas imagens enviadas em pouco tempo', /Aguarde cerca de 30 segundos/],
    ['503 ocupado', () => E.erroDeEnvio(503, 'IMAGENS_OCUPADO', { cabecalhos: { 'Retry-After': '5' } }), 'O servidor está ocupado processando outras imagens', /Aguarde cerca de 5 segundos/],
    ['503 indisponível', () => E.erroDeEnvio(503, 'IMAGENS_INDISPONIVEL'), 'O armazenamento de imagens está indisponível no momento', /indisponível no momento/],
  ];

  for (const [rotulo, falha, trecho, espera] of cenarios) {
    test(`GC-22 (${rotulo}) o lote que para por esse motivo mostra o texto uma vez (no aviso do lote), as imagens que não saíram ficam “Aguardando envio” e a espera sugerida aparece`, async () => {
      const { pg, b } = await abrirCom();
      await E.abrirEnvio(pg);
      await E.escolherArquivos(pg, [foto(1), foto(2), foto(3)]);
      b.roteiroEnvio.push(falha());
      await E.enviarLote(pg, b);
      const texto = E.textoDoSeletor(pg);
      assert.equal(ocorrencias(texto, trecho), 1, `"${trecho}" apareceu ${ocorrencias(texto, trecho)} vezes: ${texto}`);
      assert.match(texto, espera);
      assert.equal(ocorrencias(texto, 'Aguardando envio'), 3, 'nenhuma foi aceita: todas continuam aguardando');
      assert.equal(b.envios.length, 1, 'o lote parou na primeira');
    });
  }

  test('GC-23 quando o motivo da linha é OUTRO que o do aviso (uma recusada por formato e depois a parada por limite), cada texto aparece na sua linha e o do limite não se repete', async () => {
    const { pg, b } = await abrirCom();
    await E.abrirEnvio(pg);
    const lista = [foto(1), foto(2)];
    await E.escolherArquivos(pg, lista);
    b.roteiroEnvio.push(E.erroDeEnvio(415, 'IMAGEM_FORMATO_NAO_SUPORTADO'), E.erroDeEnvio(429, 'LIMITE_REQUISICOES_EXCEDIDO'));
    await E.enviarLote(pg, b);
    const texto = E.textoDoSeletor(pg);
    assert.equal(ocorrencias(texto, 'Muitas imagens enviadas em pouco tempo'), 1, texto);
    assert.match(E.textoDoItem(pg, lista[0]), /Recusada/);
    assert.match(E.textoDoItem(pg, lista[0]), /formato/i, 'a linha recusada mantém o seu motivo próprio');
    assert.match(E.textoDoItem(pg, lista[1]), /Aguardando envio/);
    assert.doesNotMatch(E.textoDoItem(pg, lista[1]), /Muitas imagens enviadas/);
  });
});
