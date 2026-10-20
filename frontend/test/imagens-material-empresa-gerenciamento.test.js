'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const E = require('./helpers/imagens-material-empresa');

/**
 * Unidade 5C-7 (RED do frontend) — GERENCIAR as imagens da empresa (renomear, inativar, reativar, excluir). O que já está fixado, sem decidir a aparência:
 *   - as quatro ações existem no backend (PATCH, POST inativar, POST reativar e DELETE em /imagens-material/empresa/:id), exigem materials.editar e valem só para a biblioteca
 *     da empresa (o contrato e a permissão de cada rota estão em imagens-material-empresa-contrato.test.js; o módulo js/imagens-material.js e o texto de cada falha, em
 *     imagens-material-empresa-biblioteca-modulo.test.js; o comportamento da biblioteca simulada, nos autotestes do auxiliar);
 *   - nesta página, a Biblioteca Padrão NUNCA é gerenciável e quem não tem materials.editar não vê nenhum controle de gerenciamento (guardas abaixo, que nascem verdes);
 *   - escolher imagem no seletor jamais escreve na biblioteca.
 * A INTERFACE do gerenciamento (onde ficam os controles, o modo "Gerenciar", as confirmações, o filtro de inativas, o aviso de uso) AINDA NÃO FOI APROVADA: antes da 5C-8 há uma
 * proposta objetiva para o responsável aprovar (documento 62). Por isso o resto é pendente (test.todo) e vira teste na 5C-8, depois da aprovação, sem reescrever o que está acima.
 */

const { H } = E;
const { IDS } = H;

const EMPRESA = [{ id: '5001', nome: 'Luva da empresa', versao: 1 }, { id: '5002', nome: 'Botina antiga da empresa', versao: 3 }];
const abrirCom = (empresa = EMPRESA, extra = {}) => E.abrir({ biblioteca: E.criarBiblioteca({ empresa, proximoId: 6001 }), ...extra });
const VERBOS_DE_GERENCIAMENTO = /Renomear|Inativar|Reativar|Excluir|Apagar|Remover imagem|Gerenciar/i;
const permissoesSem = (operacao) => H.permissoes({ materials: { ...H.TUDO, [operacao]: false } });

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 GE — guardas do gerenciamento (nascem verdes e valem depois da 5C-8)', () => {
  test('GE-01 (nasce verde) sem materials.editar o seletor não oferece NENHUM controle de gerenciar (renomear, inativar, reativar, excluir), com ou sem imagens da empresa', async () => {
    for (const empresa of [[], EMPRESA]) {
      const { pg } = await abrirCom(empresa, { p: permissoesSem('editar') });
      await H.abrirSeletor(pg);
      assert.deepEqual(E.nomesDosBotoes(E.modal(pg)).filter((nome) => VERBOS_DE_GERENCIAMENTO.test(nome)), [], `${empresa.length} imagens da empresa`);
    }
  });

  test('GE-02 (nasce verde) a Biblioteca Padrão nunca é gerenciável: nenhum item padrão leva botão nem fala em renomear, inativar ou excluir, nem para quem tem todas as permissões', async () => {
    const { pg } = await abrirCom();
    await H.abrirSeletor(pg);
    const padrao = H.itens(pg).filter((e) => e.getAttribute('data-imagem-origem') === 'PADRAO');
    assert.equal(padrao.length, 30);
    for (const item of padrao) {
      assert.equal(item.querySelectorAll('button').length, 0, E.textoVisivel(item));
      assert.doesNotMatch(E.textoVisivel(item), VERBOS_DE_GERENCIAMENTO);
    }
  });

  test('GE-03 (nasce verde) abrir o seletor, pesquisar, marcar, confirmar, cancelar e fechar nunca escrevem na biblioteca: nenhum PATCH, POST ou DELETE de imagem e nenhum envio binário', async () => {
    const { pg, envios } = await abrirCom();
    await H.abrirSeletor(pg);
    pg.el(IDS.busca).value = 'luva';
    await pg.el(IDS.busca).disparar('input');
    await pg.esperar();
    await H.marcar(pg, 0);
    await pg.clicar(IDS.cancelar);
    await H.abrirSeletor(pg);
    await H.marcar(pg, 1);
    await H.confirmar(pg);
    await H.abrirSeletor(pg);
    await H.pressionar(pg.el(IDS.busca), 'Escape');
    await pg.esperar();
    assert.deepEqual(pg.chamadas.filter((c) => c.metodo !== 'GET'), []);
    assert.deepEqual(pg.chamadas.filter((c) => /imagens-material\/empresa/.test(c.caminho)), []);
    assert.equal(envios.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
// 5C-8b: a interface do gerenciamento foi aprovada por Ramires em 18/10/2026 (modo "Gerenciar" na aba "Minha Empresa", só com materials.editar, em vista própria do
// mesmo pop-up). Os dez pendentes da 5C-7 (GE-T01 a GE-T10) viram testes abaixo, com os mesmos títulos; o que o título não diz está nos testes GC do complemento.
const GES = { vista: 'imagemVistaGestao', lista: 'imagemGestaoLista', aviso: 'imagemGestaoAviso', contagem: 'imagemGestaoContagem', inativas: 'imagemGestaoInativas', concluir: 'botaoImagemGestaoConcluir' };
const botaoGerenciar = (pg) => E.botaoPorNome(E.modal(pg), /^Gerenciar imagens$/);
const linhasDaGestao = (pg) => pg.el(GES.lista).children;
const linhaDaGestao = (pg, nome) => linhasDaGestao(pg).find((li) => E.normalizarTexto(E.textoVisivel(li)).includes(nome)) ?? null;
// Durante a edição do nome o nome está no campo (valor), não no texto da linha: a linha, nesse caso, só se acha pelo id.
const linhaPorId = (pg, id) => linhasDaGestao(pg).find((li) => li.getAttribute('data-imagem-id') === id) ?? null;
const campoDoNomeDe = (pg, id) => linhaPorId(pg, id).querySelectorAll('input').find((i) => i.type === 'text') ?? null;
const botaoDaLinha = (linha, verbo) => linha.querySelectorAll('button').find((b) => E.nomeAcessivel(b).startsWith(verbo)) ?? null;
// Nó do DOM nunca vai para assert.equal: na falha o Node monta a mensagem inspecionando o grafo circular do nó e o processo trava. Compara-se a identidade.
const mesmo = (real, esperado, mensagem) => assert.ok(real === esperado, mensagem);
const nulo = (real, mensagem) => assert.ok(real === null, mensagem);
const escritas = (pg) => pg.chamadas.filter((c) => c.metodo !== 'GET');
const leituras = (pg) => E.chamadasDaLista(pg).length;
const avisoDaGestao = (pg) => E.normalizarTexto(pg.texto(GES.aviso));
const usadaPor = (idImagem, nome = 'Fita isolante preta') => ({ id: 701, nome, imagem: { origem: 'EMPRESA', id: idImagem, versao: 1, nome: 'x' } });

async function entrarNoGerenciar(pg) {
  await H.abrirSeletor(pg);
  await E.irParaAba(pg, 'Minha Empresa');
  assert.ok(E.acionavel(pg, botaoGerenciar(pg)), 'o botão "Gerenciar imagens" aparece na aba Minha Empresa');
  await botaoGerenciar(pg).disparar('click');
  await E.aguardar(pg);
}

describe('5C-8b GE — gerenciar as imagens da empresa: os pendentes da 5C-7 (GE-T01 a GE-T10) agora como testes', () => {
  test('GE-T01 entrada do gerenciamento: modo "Gerenciar" na aba "Minha Empresa", visível só com materials.editar; a Biblioteca Padrão não entra nele', async () => {
    const { pg } = await abrirCom();
    await H.abrirSeletor(pg);
    assert.equal(E.acionavel(pg, botaoGerenciar(pg)), false, 'em "Todas" não há gerenciar');
    await E.irParaAba(pg, 'Padrão SafeWork');
    assert.equal(E.acionavel(pg, botaoGerenciar(pg)), false, 'a Biblioteca Padrão não entra no modo');
    await E.irParaAba(pg, 'Minha Empresa');
    assert.equal(E.acionavel(pg, botaoGerenciar(pg)), true);
    const antes = leituras(pg);
    await botaoGerenciar(pg).disparar('click');
    await E.aguardar(pg);
    assert.equal(pg.visivelNo(pg.el(GES.vista)), true);
    assert.equal(pg.visivelNo(pg.el('imagemVistaBiblioteca')), false);
    assert.match(pg.texto('imagemGestaoTitulo'), /Gerenciar imagens da empresa/);
    const consulta = E.consultaDaChamada(E.chamadasDaLista(pg).at(-1));
    assert.deepEqual([consulta.origem, consulta.estado, consulta.pagina, consulta.limite], ['EMPRESA', 'TODAS', '1', '100']);
    assert.equal(leituras(pg), antes + 1, 'uma leitura só');
    assert.deepEqual(linhasDaGestao(pg).map((li) => li.getAttribute('data-imagem-origem')), ['EMPRESA', 'EMPRESA'], 'só imagens da empresa, nenhuma da Padrão');
    assert.equal(escritas(pg).length, 0, 'entrar no modo não escreve nada');
    // sem materials.editar o botão nem existe, mesmo com materials.criar (nenhum controle de gerenciar, como na guarda GE-01)
    const semEditar = await abrirCom(EMPRESA, { p: permissoesSem('editar') });
    await H.abrirSeletor(semEditar.pg);
    await E.irParaAba(semEditar.pg, 'Minha Empresa');
    nulo(botaoGerenciar(semEditar.pg), 'sem materials.editar o botão nem existe');
    // só materials.editar (sem criar): o formulário só abre na edição de um material existente, e ali o botão existe — a regra é a permissão efetiva, não o perfil
    const soEditar = await abrirCom(EMPRESA, { p: H.permissoes({ materials: { visualizar: true, criar: false, editar: true, excluir: false } }) });
    await H.entrarNaEdicao(soEditar.pg);
    await H.abrirSeletor(soEditar.pg);
    await E.irParaAba(soEditar.pg, 'Minha Empresa');
    assert.equal(E.acionavel(soEditar.pg, botaoGerenciar(soEditar.pg)), true);
  });

  test('GE-T02 renomear: mesma regra de nome do envio (1 a 100, sem controle); Enter confirma e Escape cancela; 404 (outra pessoa excluiu) e 403 mantêm a lista e explicam; nome inalterado não chama o servidor', async () => {
    const { pg, b } = await abrirCom();
    await entrarNoGerenciar(pg);
    const digitar = async (id, texto) => {
      campoDoNomeDe(pg, id).value = texto;
      await campoDoNomeDe(pg, id).disparar('input');
    };
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear').disparar('click');
    await pg.esperar();
    assert.equal(campoDoNomeDe(pg, '5001').value, 'Luva da empresa', 'o campo já vem com o nome atual');
    mesmo(pg.documento.activeElement, campoDoNomeDe(pg, '5001'), 'o foco vai para o campo');
    for (const ruim of ['', '   ', 'x'.repeat(101), 'a\u0007b']) {
      await digitar('5001', ruim);
      await H.pressionar(campoDoNomeDe(pg, '5001'), 'Enter');
      await pg.esperar();
      assert.match(E.normalizarTexto(E.textoVisivel(linhaPorId(pg, '5001'))), /Informe um nome de 1 a 100 caracteres/, JSON.stringify(ruim));
    }
    assert.equal(escritas(pg).length, 0, 'nome inválido nunca vai ao servidor');
    await digitar('5001', 'Luva da empresa');
    await H.pressionar(campoDoNomeDe(pg, '5001'), 'Enter');
    await E.aguardar(pg);
    assert.equal(escritas(pg).length, 0, 'nome inalterado não chama o servidor');
    assert.match(avisoDaGestao(pg), /não foi alterado/);
    nulo(campoDoNomeDe(pg, '5001'), 'o campo fecha');
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear').disparar('click');
    await pg.esperar();
    await digitar('5001', 'Descartar isto');
    await H.pressionar(campoDoNomeDe(pg, '5001'), 'Escape');
    await pg.esperar();
    assert.equal(pg.el('modalImagemMaterial').getAttribute('aria-hidden'), 'false', 'Escape cancelou só a edição, o pop-up segue aberto');
    assert.ok(linhaDaGestao(pg, 'Luva da empresa'), 'o nome original continua');
    assert.equal(escritas(pg).length, 0);
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear').disparar('click');
    await pg.esperar();
    await digitar('5001', '  Luva de raspa da empresa  ');
    await H.pressionar(campoDoNomeDe(pg, '5001'), 'Enter');
    await E.aguardar(pg);
    assert.deepEqual(escritas(pg).map((c) => [c.metodo, c.caminho, c.corpo]), [['PATCH', '/imagens-material/empresa/5001', { nome: 'Luva de raspa da empresa' }]], 'o nome vai aparado');
    assert.ok(linhaDaGestao(pg, 'Luva de raspa da empresa'), 'a lista mostra o novo nome');
    nulo(linhaDaGestao(pg, 'Luva da empresa'));
    assert.match(avisoDaGestao(pg), /agora se chama “Luva de raspa da empresa”/);
    // 404: outra pessoa excluiu a imagem antes de salvar o nome
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Renomear').disparar('click');
    await pg.esperar();
    b.empresa = b.empresa.filter((i) => i.id !== '5002');
    const antes = leituras(pg);
    await digitar('5002', 'Botina nova');
    await H.pressionar(campoDoNomeDe(pg, '5002'), 'Enter');
    await E.aguardar(pg);
    assert.match(avisoDaGestao(pg), /não está mais disponível/);
    nulo(linhaPorId(pg, '5002'), 'a linha da imagem que sumiu sai da lista');
    assert.equal(leituras(pg), antes + 1, 'a lista foi lida de novo, uma vez');
    assert.equal(escritas(pg).length, 2, 'nada foi repetido sozinho');
    // 403: a permissão foi retirada no servidor
    b.permissoes = permissoesSem('editar');
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear').disparar('click');
    await pg.esperar();
    await digitar('5001', 'Outro nome');
    await H.pressionar(campoDoNomeDe(pg, '5001'), 'Enter');
    await E.aguardar(pg);
    assert.match(avisoDaGestao(pg), /permiss/i);
    assert.ok(linhaPorId(pg, '5001'), 'a lista continua como estava');
    assert.equal(campoDoNomeDe(pg, '5001')?.value, 'Outro nome', 'o campo continua aberto com o que foi digitado');
    assert.equal(pg.textoDoDom().includes(E.TEXTO_DO_SERVIDOR), false);
  });

  test('GE-T03 inativar: desabilitado com o motivo quando a imagem está em uso por material (emUso > 0; o servidor responde 409 IMAGEM_EM_USO); a imagem inativa some do seletor e continua contando na cota', async () => {
    const { pg, b } = await abrirCom(EMPRESA, { outros: [usadaPor('5002')] });
    await entrarNoGerenciar(pg);
    const usada = linhaDaGestao(pg, 'Botina antiga da empresa');
    for (const verbo of ['Inativar', 'Excluir']) {
      const botao = botaoDaLinha(usada, verbo);
      assert.equal(botao.disabled, true, `${verbo} fica desabilitado quando a imagem está em uso`);
      assert.match(botao.getAttribute('title'), /Em uso por 1 material/, 'o motivo está no próprio botão');
    }
    assert.match(E.textoVisivel(usada), /Em uso por 1 material/, 'e à vista');
    // sem uso: inativa de verdade, e o seletor deixa de oferecê-la, mas ela segue ocupando a vaga
    const livre = linhaDaGestao(pg, 'Luva da empresa');
    assert.equal(botaoDaLinha(livre, 'Inativar').disabled, false);
    await botaoDaLinha(livre, 'Inativar').disparar('click');
    await E.aguardar(pg);
    assert.deepEqual(escritas(pg).map((c) => [c.metodo, c.caminho, c.corpo]), [['POST', '/imagens-material/empresa/5001/inativar', {}]]);
    assert.equal(b.acharEmpresa('5001').estado, 'INATIVA');
    assert.equal(b.empresa.length, 2, 'inativar mantém a imagem e a vaga na cota');
    assert.match(avisoDaGestao(pg), /foi inativada.*continua ocupando uma vaga da cota/);
    nulo(linhaDaGestao(pg, 'Luva da empresa'), 'com as inativas ocultas a linha sai da lista');
    await pg.el(GES.concluir).disparar('click');
    await E.aguardar(pg);
    assert.deepEqual(E.pares(pg), ['EMPRESA:5002'], 'a imagem inativa não aparece mais no seletor');
    // o servidor é a autoridade: imagem que passou a ser usada depois da leitura => 409, sem repetir
    b.materiais.set(702, { ...b.materiais.get(501), id: 702, nome: 'Outro', imagem: { origem: 'EMPRESA', id: '5002', versao: 3, nome: 'x' } });
    await botaoGerenciar(pg).disparar('click');
    await E.aguardar(pg);
    assert.equal(botaoDaLinha(linhaDaGestao(pg, 'Botina antiga da empresa'), 'Inativar').disabled, true);
  });

  test('GE-T04 reativar: pelo filtro "mostrar inativas" (estado=INATIVA ou TODAS); reativar nunca é bloqueado e a imagem volta ao seletor', async () => {
    const { pg, b } = await abrirCom([...EMPRESA, { id: '5003', nome: 'Capacete antigo', versao: 1, estado: 'INATIVA' }]);
    await H.abrirSeletor(pg);
    await E.irParaAba(pg, 'Minha Empresa');
    assert.deepEqual(E.pares(pg), ['EMPRESA:5002', 'EMPRESA:5001'], 'o seletor só lista as ativas');
    await botaoGerenciar(pg).disparar('click');
    await E.aguardar(pg);
    const consulta = E.consultaDaChamada(E.chamadasDaLista(pg).at(-1));
    assert.equal(consulta.estado, 'TODAS', 'a leitura traz também as inativas');
    nulo(linhaDaGestao(pg, 'Capacete antigo'), 'por padrão as inativas ficam ocultas');
    assert.match(E.normalizarTexto(pg.texto(GES.contagem)), /2 imagens ativas · 1 inativa \(oculta\)/);
    pg.el(GES.inativas).checked = false;
    await pg.el(GES.inativas).disparar('click');
    await pg.esperar();
    const inativa = linhaDaGestao(pg, 'Capacete antigo');
    assert.ok(inativa, '"Mostrar inativas" mostra a imagem inativa');
    assert.match(E.textoVisivel(inativa), /Inativa/);
    nulo(botaoDaLinha(inativa, 'Inativar'), 'em imagem inativa o botão é Reativar');
    await botaoDaLinha(inativa, 'Reativar').disparar('click');
    await E.aguardar(pg);
    assert.deepEqual(escritas(pg).map((c) => [c.metodo, c.caminho, c.corpo]), [['POST', '/imagens-material/empresa/5003/reativar', {}]]);
    assert.equal(b.acharEmpresa('5003').estado, 'ATIVA');
    assert.match(avisoDaGestao(pg), /foi reativada e voltou ao seletor/);
    await pg.el(GES.concluir).disparar('click');
    await E.aguardar(pg);
    assert.deepEqual(E.pares(pg).sort(), ['EMPRESA:5001', 'EMPRESA:5002', 'EMPRESA:5003'], 'a imagem reativada volta ao seletor');
  });

  test('GE-T05 excluir: confirmação explícita que nomeia a imagem; só então vai { confirmacao: true }; 409 IMAGEM_EM_USO com texto próprio; excluir libera a cota (o arquivo permanece no armazenamento por desenho)', async () => {
    const { pg, b } = await abrirCom();
    await entrarNoGerenciar(pg);
    await botaoDaLinha(linhaDaGestao(pg, 'Luva da empresa'), 'Excluir').disparar('click');
    await pg.esperar();
    const painel = linhaDaGestao(pg, 'Luva da empresa').querySelectorAll('div').find((d) => d.getAttribute('role') === 'group');
    assert.ok(painel, 'a confirmação aparece na própria linha');
    assert.match(E.normalizarTexto(E.textoVisivel(painel)), /Excluir “Luva da empresa”\?/, 'a confirmação nomeia a imagem');
    assert.match(E.normalizarTexto(E.textoVisivel(painel)), /não pode ser desfeita.*vaga volta para a cota/);
    assert.equal(escritas(pg).length, 0, 'nada vai ao servidor antes da confirmação');
    assert.equal(pg.documento.activeElement && E.nomeAcessivel(pg.documento.activeElement), 'Cancelar', 'o foco começa no botão seguro');
    await H.pressionar(pg.documento.activeElement, 'Escape');
    await pg.esperar();
    assert.equal(pg.el('modalImagemMaterial').getAttribute('aria-hidden'), 'false', 'Escape cancela só a confirmação');
    assert.equal(escritas(pg).length, 0);
    await botaoDaLinha(linhaDaGestao(pg, 'Luva da empresa'), 'Excluir').disparar('click');
    await pg.esperar();
    const confirmar = botaoDaLinha(linhaDaGestao(pg, 'Luva da empresa'), 'Excluir imagem');
    await confirmar.disparar('click');
    await E.aguardar(pg);
    assert.deepEqual(escritas(pg).map((c) => [c.metodo, c.caminho, c.corpo]), [['DELETE', '/imagens-material/empresa/5001', { confirmacao: true }]]);
    assert.equal(b.empresa.length, 1, 'a vaga foi liberada');
    nulo(linhaDaGestao(pg, 'Luva da empresa'));
    assert.match(avisoDaGestao(pg), /foi excluída\. A vaga voltou para a cota/);
    // 409: a imagem passou a ser usada depois da leitura
    b.materiais.set(703, { ...b.materiais.get(501), id: 703, nome: 'Outro', imagem: { origem: 'EMPRESA', id: '5002', versao: 3, nome: 'x' } });
    await botaoDaLinha(linhaDaGestao(pg, 'Botina antiga da empresa'), 'Excluir').disparar('click');
    await pg.esperar();
    await botaoDaLinha(linhaDaGestao(pg, 'Botina antiga da empresa'), 'Excluir imagem').disparar('click');
    await E.aguardar(pg);
    assert.match(avisoDaGestao(pg), /está em uso por material e não pode ser inativada nem excluída/);
    assert.equal(escritas(pg).length, 2, 'uma tentativa só, sem repetir');
    assert.equal(b.empresa.length, 1, 'nada foi excluído');
    assert.equal(pg.textoDoDom().includes(E.TEXTO_DO_SERVIDOR), false);
  });

  test('GE-T06 mostrar o uso de cada imagem da empresa (emUso: "em uso por N materiais") e diferenciar, na própria tela, inativar (mantém a cota) de excluir (libera a cota)', async () => {
    const duas = [usadaPor('5002', 'Fita 1'), { ...usadaPor('5002', 'Fita 2'), id: 702 }];
    const { pg } = await abrirCom(EMPRESA, { outros: duas });
    await entrarNoGerenciar(pg);
    assert.match(E.textoVisivel(linhaDaGestao(pg, 'Botina antiga da empresa')), /Em uso por 2 materiais/);
    assert.match(E.textoVisivel(linhaDaGestao(pg, 'Luva da empresa')), /Sem uso em materiais/);
    const ajuda = E.normalizarTexto(E.textoVisivel(pg.el(GES.vista)));
    assert.match(ajuda, /Inativar tira a imagem do seletor, mas ela continua ocupando uma vaga da cota\. Excluir libera a vaga e não pode ser desfeito/);
    assert.match(ajuda, /Uma imagem usada por material não pode ser inativada nem excluída/);
  });

  test('GE-T07 ação sobre a imagem que está escolhida no formulário e ainda não foi salva: bloquear ou avisar, sem perder a escolha pendente', async () => {
    const { pg, b } = await abrirCom();
    await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
    assert.match(pg.texto('imagemMaterialEstado'), /Luva da empresa/);
    await entrarNoGerenciar(pg);
    const linha = linhaDaGestao(pg, 'Luva da empresa');
    assert.match(E.textoVisivel(linha), /Escolhida no formulário, ainda não salva/, 'a linha diz que a imagem está escolhida no formulário');
    assert.equal(botaoDaLinha(linha, 'Inativar').disabled, false, 'uma escolha ainda não salva não é vínculo no banco: não bloqueia');
    await botaoDaLinha(linha, 'Inativar').disparar('click');
    await E.aguardar(pg);
    assert.equal(b.acharEmpresa('5001').estado, 'INATIVA');
    assert.match(avisoDaGestao(pg), /Ela está escolhida no formulário e ainda não foi salva: ao salvar o material o servidor a recusará/);
    await pg.el(GES.concluir).disparar('click');
    await E.aguardar(pg);
    await pg.clicar(IDS.cancelar);
    assert.match(pg.texto('imagemMaterialEstado'), /Luva da empresa/, 'a escolha pendente não foi perdida');
    assert.equal(E.paresMarcados(pg).length, 0);
  });

  test('GE-T08 duas pessoas gerenciando ao mesmo tempo (404/409 vindos de outra sessão): a lista é relida e a tela diz o que mudou, sem repetir a ação sozinha', async () => {
    const { pg, b } = await abrirCom([...EMPRESA, { id: '5003', nome: 'Capacete da empresa', versao: 1 }]);
    await entrarNoGerenciar(pg);
    // 404: outra sessão excluiu a 5003 depois da leitura desta tela
    b.empresa = b.empresa.filter((i) => i.id !== '5003');
    const antes = leituras(pg);
    await botaoDaLinha(linhaPorId(pg, '5003'), 'Inativar').disparar('click');
    await E.aguardar(pg);
    assert.match(avisoDaGestao(pg), /não está mais disponível/, '404: a tela diz o que mudou');
    nulo(linhaPorId(pg, '5003'));
    assert.equal(leituras(pg), antes + 1);
    // 409: outra sessão passou a usar a 5001 depois da leitura (a tela ainda a mostra sem uso e com Inativar habilitado)
    b.materiais.set(704, { ...b.materiais.get(501), id: 704, nome: 'Outro', imagem: { origem: 'EMPRESA', id: '5001', versao: 1, nome: 'x' } });
    assert.match(E.textoVisivel(linhaPorId(pg, '5001')), /Sem uso em materiais/);
    assert.equal(botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar').disabled, false);
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar').disparar('click');
    await E.aguardar(pg);
    assert.match(avisoDaGestao(pg), /está em uso por material/, '409: a tela diz o que mudou');
    assert.equal(leituras(pg), antes + 2, 'a lista é relida de novo');
    assert.match(E.textoVisivel(linhaPorId(pg, '5001')), /Em uso por 1 material/, 'agora a linha mostra o uso novo');
    assert.equal(botaoDaLinha(linhaPorId(pg, '5001'), 'Inativar').disabled, true);
    assert.equal(b.acharEmpresa('5001').estado, 'ATIVA', 'a imagem continua ativa');
    await pg.avancar();
    assert.equal(escritas(pg).length, 2, 'cada ação saiu uma vez: nenhuma repetição automática');
  });

  test('GE-T09 foco e anúncio por leitor de tela (aria-live) depois de cada ação de gerenciamento, e foco devolvido ao controle de origem', async () => {
    const { pg } = await abrirCom();
    await entrarNoGerenciar(pg);
    const aviso = pg.el(GES.aviso);
    assert.deepEqual([aviso.getAttribute('role'), aviso.getAttribute('aria-live')], ['status', 'polite'], 'os resultados são anunciados em região viva');
    assert.deepEqual([pg.el(GES.contagem).getAttribute('role'), pg.el(GES.contagem).getAttribute('aria-live')], ['status', 'polite']);
    // renomear: o foco volta ao "Renomear" da mesma linha
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear').disparar('click');
    await pg.esperar();
    campoDoNomeDe(pg, '5001').value = 'Luva nova';
    await campoDoNomeDe(pg, '5001').disparar('input');
    await H.pressionar(campoDoNomeDe(pg, '5001'), 'Enter');
    await E.aguardar(pg);
    mesmo(pg.documento.activeElement, botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear'), 'depois de renomear, o foco volta ao Renomear da linha');
    assert.match(avisoDaGestao(pg), /agora se chama “Luva nova”/);
    // inativar com as inativas ocultas: a linha some e o foco passa à linha vizinha
    await botaoDaLinha(linhaPorId(pg, '5002'), 'Inativar').disparar('click');
    await E.aguardar(pg);
    nulo(linhaPorId(pg, '5002'));
    mesmo(pg.documento.activeElement, botaoDaLinha(linhaPorId(pg, '5001'), 'Renomear'), 'a linha sumiu: o foco vai à vizinha');
    // cancelar a confirmação devolve o foco ao "Excluir" que a abriu
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Excluir').disparar('click');
    await pg.esperar();
    await botaoDaLinha(linhaPorId(pg, '5001'), 'Cancelar').disparar('click');
    await pg.esperar();
    mesmo(pg.documento.activeElement, botaoDaLinha(linhaPorId(pg, '5001'), 'Excluir'), 'cancelar devolve o foco ao controle de origem');
  });

  test('GE-T10 forma da confirmação das ações destrutivas (diálogo próprio do projeto ou confirmação nativa) e texto exato dos avisos', async () => {
    const { pg, b } = await abrirCom();
    let nativas = 0;
    pg.janela.confirm = () => { nativas += 1; return true; };
    await entrarNoGerenciar(pg);
    await botaoDaLinha(linhaDaGestao(pg, 'Luva da empresa'), 'Excluir').disparar('click');
    await pg.esperar();
    assert.equal(nativas, 0, 'a confirmação é do próprio pop-up (na linha), nunca a nativa do navegador');
    assert.equal(escritas(pg).length, 0);
    const painel = linhaPorId(pg, '5001').querySelectorAll('div').find((d) => d.getAttribute('role') === 'group');
    const partes = painel.querySelectorAll('p').map((p) => E.normalizarTexto(E.textoVisivel(p)));
    assert.deepEqual(partes, ['Excluir “Luva da empresa”?', 'Esta ação não pode ser desfeita. A imagem sai da biblioteca da sua empresa e a vaga volta para a cota.']);
    await botaoDaLinha(linhaDaGestao(pg, 'Luva da empresa'), 'Excluir imagem').disparar('click');
    await E.aguardar(pg);
    assert.equal(avisoDaGestao(pg), 'A imagem “Luva da empresa” foi excluída. A vaga voltou para a cota.');
    await botaoDaLinha(linhaDaGestao(pg, 'Botina antiga da empresa'), 'Inativar').disparar('click');
    await E.aguardar(pg);
    assert.equal(avisoDaGestao(pg), 'A imagem “Botina antiga da empresa” foi inativada. Ela saiu do seletor, mas continua ocupando uma vaga da cota.');
    assert.equal(nativas, 0);
    assert.equal(b.empresa.length, 1);
  });
});
