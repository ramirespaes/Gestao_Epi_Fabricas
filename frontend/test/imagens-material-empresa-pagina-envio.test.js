'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('./helpers/imagens-material-empresa');

/**
 * Unidade 5C-7 (RED do frontend) — a VISTA DE ENVIO dentro do seletor de imagens: o botão "Adicionar imagens", a escolha de arquivos no computador, as validações locais, o nome de
 * cada imagem, o envio um a um para a biblioteca da empresa, o que a tela mostra de cada resultado (criada, já existia, recusada, incerta, parada por sessão, permissão, cota, limite
 * ou indisponibilidade), a ausência de envio em duplicidade e a higiene de segurança (texto puro, prévias liberadas, nada no navegador nem no console). Roda a página real no harness
 * de DOM sobre a biblioteca simulada com estado (helpers/imagens-material-empresa.js); o POST binário é interceptado pelo auxiliar e guarda URL, credenciais, cabeçalhos e o próprio
 * File. Os controles são achados pelo nome acessível dos rótulos do protótipo V6 aprovado ("Adicionar imagens", "Voltar à biblioteca", "Adicionar à biblioteca", "Nome da imagem N",
 * "Tirar <arquivo> da lista"), nunca por classe. Sem decodificador de imagem no harness: a pré-checagem de dimensões do protótipo ficou entre os pendentes. Todo teste que depende
 * de algo ainda inexistente falha com "comportamento ausente:". O backend continua a autoridade; a tela só orienta.
 */

const { H, P, MARCA } = E;
const { IDS } = H;

const EMPRESA = [{ id: '5001', nome: 'Luva da empresa', versao: 1 }];
const abrirCom = (empresa = EMPRESA, extra = {}) => E.abrir({ biblioteca: E.criarBiblioteca({ empresa, proximoId: 6001 }), ...extra });
const foto = (n) => E.arquivo({ nome: `foto-${n}.png`, tipo: 'image/png', semente: `pe-${n}` });
const fotos = (n) => Array.from({ length: n }, (_, i) => foto(i + 1));
const comArquivos = async (pg, lista) => {
  await E.abrirEnvio(pg);
  await E.escolherArquivos(pg, lista);
};
const linha = (pg, arquivo) => E.textoDoItem(pg, arquivo);
const nomeDe = (pg, arquivo) => E.itemDoArquivo(pg, arquivo).nomeInput.value;
const botoesDeLinha = (pg) => E.modal(pg).querySelectorAll('button').filter((b) => /^Tirar .+ da lista$/.test(E.nomeAcessivel(b)));
const aberto = (pg) => !E.naoVisivel(pg, E.campoDeArquivos(pg));
const doEmpresa = (lista) => lista.filter((p) => p.startsWith('EMPRESA:'));

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 PE — a porta de entrada: página, módulo e permissão', () => {
  test('PE-01 a página carrega o módulo de envio depois do EpiHttp e antes do script da página, e o módulo está na allowlist da publicação (senão o pacote é recusado)', () => {
    const html = fs.readFileSync(path.join(E.RAIZ, 'pages/materials.html'), 'utf8');
    const posicao = (src) => html.indexOf(`<script src="${src}"></script>`);
    assert.ok(posicao('../js/imagens-envio.js') >= 0, `${MARCA} pages/materials.html não carrega ../js/imagens-envio.js`);
    assert.ok(posicao('../js/api-http.js') >= 0 && posicao('../js/api-http.js') < posicao('../js/imagens-envio.js'), 'o EpiHttp vem antes do módulo de envio');
    assert.ok(posicao('../js/imagens-envio.js') < html.lastIndexOf('<script>'), 'o módulo vem antes do script da página');
    const { arquivos } = JSON.parse(fs.readFileSync(path.join(E.RAIZ, 'publicacao/allowlist.json'), 'utf8'));
    assert.ok(arquivos.includes('js/imagens-envio.js'), `${MARCA} js/imagens-envio.js fora de frontend/publicacao/allowlist.json`);
  });

  test('PE-02 "Adicionar imagens" é oferecido a quem pode enviar (materials.criar) e NÃO é acionável para quem só tem materials.editar (edição de material): o servidor negaria o envio', async () => {
    const comCriar = await abrirCom();
    await H.abrirSeletor(comCriar.pg);
    assert.equal(E.acionavel(comCriar.pg, E.botaoAdicionar(comCriar.pg)), true, `${MARCA} botão "Adicionar imagens" no seletor para quem tem materials.criar`);
    const soEditar = await abrirCom(EMPRESA, { p: H.permissoes({ materials: { visualizar: true, criar: false, editar: true, excluir: false } }) });
    await H.entrarNaEdicao(soEditar.pg);
    await H.abrirSeletor(soEditar.pg);
    assert.equal(E.acionavel(soEditar.pg, E.botaoAdicionar(soEditar.pg)), false);
    assert.equal(soEditar.envios.length, 0);
  });

  test('PE-03 "Adicionar imagens" abre a vista de envio no MESMO pop-up: campo de arquivos (vários; só PNG, JPEG e WebP), "Voltar à biblioteca", "Adicionar à biblioteca" desabilitado e a lista da biblioteca fora de cena', async () => {
    const { pg, envios } = await abrirCom();
    const campo = await E.abrirEnvio(pg);
    assert.deepEqual(campo.getAttribute('accept').split(',').sort(), [...E.TIPOS_ACEITOS].sort());
    assert.notEqual(campo.getAttribute('multiple'), null, 'vários arquivos de uma vez');
    assert.ok(E.botaoVoltar(pg), `${MARCA} botão "Voltar à biblioteca"`);
    assert.ok(E.botaoEnviar(pg), `${MARCA} botão "Adicionar à biblioteca"`);
    assert.equal(E.botaoEnviar(pg).disabled, true, 'nada para enviar ainda');
    assert.equal(E.naoVisivel(pg, pg.documento.getElementById(IDS.lista)), true, 'a lista da biblioteca sai de cena');
    assert.equal(pg.el(IDS.modal).getAttribute('aria-hidden'), 'false');
    assert.equal(envios.length, 0);
  });

  test('PE-04 "Voltar à biblioteca" devolve a vista da biblioteca (lista e abas de volta) e descarta o que estava na lista de envio', async () => {
    const { pg, envios } = await abrirCom();
    await comArquivos(pg, fotos(2));
    assert.equal(botoesDeLinha(pg).length, 2);
    await E.botaoVoltar(pg).disparar('click');
    await pg.esperar();
    assert.equal(aberto(pg), false);
    assert.equal(E.naoVisivel(pg, pg.documento.getElementById(IDS.lista)), false);
    assert.deepEqual(E.abasAtivas(pg), ['Todas']);
    await E.abrirEnvio(pg);
    assert.equal(botoesDeLinha(pg).filter((b) => pg.visivelNo(b)).length, 0, 'a lista de envio recomeça vazia');
    assert.equal(envios.length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 PE — escolher os arquivos: uma linha por imagem, nome sugerido e validações da tela', () => {
  test('PE-05 escolher 3 imagens válidas: uma linha por arquivo com o nome sugerido (sem extensão; "_" e "-" viram espaço), campo de nome editável, resumo "3 prontas" e envio habilitado; nada é enviado ainda', async () => {
    const { pg, envios } = await abrirCom();
    const a = E.arquivo({ nome: 'luva_nitrilica-azul.PNG', semente: 'a' });
    const b = E.arquivo({ nome: 'Capacete de Segurança.jpeg', tipo: 'image/jpeg', semente: 'b' });
    const c = E.arquivo({ nome: 'sem-extensao', tipo: 'image/webp', semente: 'c' });
    await comArquivos(pg, [a, b, c]);
    assert.deepEqual([a, b, c].map((x) => nomeDe(pg, x)), ['luva nitrilica azul', 'Capacete de Segurança', 'sem extensao']);
    assert.match(E.textoDoSeletor(pg), /3 prontas?\b/i);
    assert.equal(E.botaoEnviar(pg).disabled, false);
    assert.equal(envios.length, 0);
  });

  test('PE-06 cada campo de nome tem rótulo acessível "Nome da imagem N" (N = posição na lista) e o botão de tirar da lista leva o nome do arquivo no rótulo', async () => {
    const { pg } = await abrirCom();
    const lista = fotos(3);
    await comArquivos(pg, lista);
    lista.forEach((arq, i) => {
      assert.equal(E.itemDoArquivo(pg, arq).nomeInput.getAttribute('aria-label'), `Nome da imagem ${i + 1}`);
      assert.equal(E.itemDoArquivo(pg, arq).remover.getAttribute('aria-label'), `Tirar ${arq.name} da lista`);
    });
  });

  test('PE-07 o nome segue a regra do servidor: vazio, só espaços, mais de 100 caracteres e caractere de controle bloqueiam o envio e mostram o motivo na própria linha; um nome válido libera de novo', async () => {
    const { pg } = await abrirCom();
    const [a, b] = fotos(2);
    await comArquivos(pg, [a, b]);
    for (const ruim of ['', '   ', 'x'.repeat(101), 'a\u0007b']) {
      await E.digitarNome(pg, a, ruim);
      assert.equal(E.botaoEnviar(pg).disabled, true, `nome ${JSON.stringify(ruim)}`);
      assert.match(linha(pg, a), /1 a 100/, `nome ${JSON.stringify(ruim)}`);
      assert.doesNotMatch(linha(pg, b), /1 a 100/, 'o erro é só da linha com problema');
    }
    await E.digitarNome(pg, a, 'Luva boa');
    assert.equal(E.botaoEnviar(pg).disabled, false);
    assert.doesNotMatch(linha(pg, a), /1 a 100/);
  });

  test('PE-08 arquivo que o servidor recusaria é recusado NA TELA, com o motivo na linha (formato, mais de 2 MiB, vazio); fica fora do envio, sem campo de nome, e o que é válido segue', async () => {
    const { pg, b, envios } = await abrirCom();
    const bom = foto(1);
    const gif = E.arquivo({ nome: 'figura.gif', tipo: 'image/gif', semente: 'g' });
    const svg = E.arquivo({ nome: 'vetor.svg', tipo: 'image/svg+xml', semente: 's' });
    const grande = E.arquivo({ nome: 'enorme.png', tamanho: (2 * E.MIB) + 1 });
    const vazio = E.arquivo({ nome: 'vazio.png', tamanho: 0 });
    await comArquivos(pg, [bom, gif, svg, grande, vazio]);
    assert.match(linha(pg, gif), /PNG, JPEG ou WebP/);
    assert.match(linha(pg, svg), /PNG, JPEG ou WebP/);
    assert.match(linha(pg, grande), /2 ?MiB/);
    assert.match(linha(pg, vazio), /vazi/i);
    for (const recusado of [gif, svg, grande, vazio]) assert.equal(E.itemDoArquivo(pg, recusado).nomeInput, null, 'recusado não tem campo de nome');
    assert.match(E.textoDoSeletor(pg), /1 prontas?\b/i);
    assert.match(E.textoDoSeletor(pg), /4 recusadas?\b/i);
    assert.equal(envios.length, 0);
    await E.enviarLote(pg, b);
    assert.deepEqual(envios.map((e) => e.nome), ['foto 1']);
    assert.equal(envios[0].corpo, bom);
  });

  test('PE-09 o lote tem no máximo 10 imagens por vez: o que passa disso é ignorado com aviso, a conta soma as escolhas seguintes e tirar uma da lista abre vaga', async () => {
    const { pg } = await abrirCom();
    const lista = fotos(12);
    await comArquivos(pg, lista);
    assert.deepEqual(botoesDeLinha(pg).map(E.nomeAcessivel), lista.slice(0, 10).map((a) => `Tirar ${a.name} da lista`));
    assert.match(E.textoDoSeletor(pg), /limite.*10|10 imagens por vez/i);
    await E.escolherArquivos(pg, [foto(13)]);
    assert.equal(botoesDeLinha(pg).length, 10, 'o lote já está cheio');
    await botoesDeLinha(pg)[0].disparar('click');
    await pg.esperar();
    assert.equal(botoesDeLinha(pg).length, 9);
    await E.escolherArquivos(pg, [foto(14)]);
    assert.equal(botoesDeLinha(pg).length, 10);
  });

  test('PE-10 a mesma imagem escolhida duas vezes (mesmo conteúdo, ainda que com outro nome) fica marcada como reaproveitada e NÃO é enviada de novo; a primeira segue normalmente', async () => {
    const { pg, b, envios } = await abrirCom();
    const a = E.arquivo({ nome: 'luva-1.png', semente: 'mesmo-conteudo' });
    const copia = E.arquivo({ nome: 'luva-copia.png', semente: 'mesmo-conteudo' });
    await comArquivos(pg, [a, copia]);
    assert.match(linha(pg, copia), /mesma imagem/i);
    assert.match(linha(pg, copia), /reaproveit/i);
    assert.doesNotMatch(linha(pg, a), /mesma imagem/i);
    assert.match(E.textoDoSeletor(pg), /1 prontas?\b/i);
    assert.match(E.textoDoSeletor(pg), /1 reaproveitadas?\b/i);
    await E.enviarLote(pg, b);
    assert.equal(envios.length, 1);
    assert.equal(envios[0].corpo, a);
  });

  test('PE-11 tirar da lista remove só aquela linha, mantém as outras (e os nomes que a pessoa digitou) e, sem nenhuma imagem pronta, o envio volta a ficar desabilitado', async () => {
    const { pg } = await abrirCom();
    const [a, b] = fotos(2);
    await comArquivos(pg, [a, b]);
    await E.digitarNome(pg, b, 'Nome digitado');
    await E.itemDoArquivo(pg, a).remover.disparar('click');
    await pg.esperar();
    assert.equal(botoesDeLinha(pg).length, 1);
    assert.equal(nomeDe(pg, b), 'Nome digitado');
    assert.equal(E.botaoEnviar(pg).disabled, false);
    await E.itemDoArquivo(pg, b).remover.disparar('click');
    await pg.esperar();
    assert.equal(botoesDeLinha(pg).length, 0);
    assert.equal(E.botaoEnviar(pg).disabled, true);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 PE — o envio: o que sai pela rede e o que a tela mostra no fim', () => {
  test('PE-12 enviar: um POST por imagem, um de cada vez e na ordem da lista, para /imagens-material/empresa?nome=<nome da linha>, com cookie de sessão, SÓ o Content-Type do arquivo e o próprio arquivo como corpo', async () => {
    const { pg, b, envios } = await abrirCom();
    const lista = [E.arquivo({ nome: 'a.png', semente: '1' }), E.arquivo({ nome: 'b.jpg', tipo: 'image/jpeg', semente: '2' }), E.arquivo({ nome: 'c.webp', tipo: 'image/webp', semente: '3' })];
    await comArquivos(pg, lista);
    await E.digitarNome(pg, lista[1], '  Luva & Cia #2  ');
    await E.enviarLote(pg, b);
    assert.equal(envios.length, 3);
    assert.equal(b.maxEmVoo, 1, 'sequencial');
    assert.deepEqual(envios.map((e) => e.corpo), lista, 'o próprio arquivo, na ordem da lista');
    assert.deepEqual(envios.map((e) => e.nome), ['a', 'Luva & Cia #2', 'c']);
    envios.forEach((e, i) => {
      assert.deepEqual([e.metodo, e.credentials, e.consulta], ['POST', 'include', ['nome']]);
      assert.equal(e.url.startsWith(`${E.API}/imagens-material/empresa?`), true);
      assert.deepEqual(Object.keys(e.cabecalhos), ['content-type']);
      assert.equal(e.cabecalhos['content-type'], lista[i].type);
    });
  });

  test('PE-13 tudo adicionado: a tela volta à biblioteca na aba "Minha Empresa" com as imagens novas (id do servidor, nome, miniatura da empresa), a vista de envio some e nada fica escolhido sozinho', async () => {
    const { pg, b } = await abrirCom();
    const lista = [foto(1), foto(2)];
    await comArquivos(pg, lista);
    await E.digitarNome(pg, lista[0], 'Capa nova');
    await E.enviarLote(pg, b);
    assert.equal(aberto(pg), false, 'a vista de envio some');
    assert.deepEqual(E.abasAtivas(pg), ['Minha Empresa']);
    assert.deepEqual(E.pares(pg).sort(), ['EMPRESA:5001', 'EMPRESA:6001', 'EMPRESA:6002']);
    const nova = H.itens(pg).find((e) => E.par(e) === 'EMPRESA:6001');
    assert.ok(E.textoVisivel(nova).includes('Capa nova'));
    assert.equal(nova.querySelector('img').getAttribute('src'), E.urlMiniaturaEmpresa({ id: '6001', versao: 1 }));
    assert.deepEqual(E.paresMarcados(pg), []);
    assert.equal(pg.el(IDS.confirmar).disabled, true);
    assert.equal(b.empresa.length, 3);
  });

  test('PE-14 a escolha feita ANTES de abrir o envio continua marcada depois de adicionar imagens: nada é trocado sozinho', async () => {
    const { pg, b } = await abrirCom();
    await H.abrirSeletor(pg);
    await H.marcar(pg, 2);
    assert.deepEqual(E.paresMarcados(pg), ['PADRAO:1003']);
    await exigirBotao(pg, /Adicionar imagens/i).disparar('click');
    await pg.esperar();
    await E.escolherArquivos(pg, [foto(1)]);
    await E.enviarLote(pg, b);
    await E.irParaAba(pg, 'Todas');
    assert.deepEqual(E.paresMarcados(pg), ['PADRAO:1003']);
    assert.equal(pg.el(IDS.confirmar).disabled, false);
  });

  test('PE-15 o servidor já tinha a imagem (200 reaproveitada): a tela avisa que já existia, ninguém é duplicado e a imagem existente aparece uma vez só', async () => {
    const conhecida = E.arquivo({ nome: 'luva.png', semente: 'ja-existe' });
    const { pg, b } = await abrirCom([{ id: '5001', nome: 'Luva da empresa', versao: 1, sha: await E.sha256Do(conhecida) }]);
    await comArquivos(pg, [conhecida]);
    const aviso = /j[áa] (existia|estava|havia)|reaproveit/i;
    assert.doesNotMatch(pg.textoDoDom(), aviso, 'antes de enviar, ninguém falou em imagem que já existia');
    await E.enviarLote(pg, b);
    assert.match(pg.textoDoDom(), aviso);
    assert.equal(b.empresa.length, 1, 'nenhuma imagem a mais na biblioteca');
    assert.equal(E.pares(pg).filter((p) => p === 'EMPRESA:5001').length, 1);
  });

  test('PE-16 recusas DO ARQUIVO pelo servidor (415, 400 de dimensões, 422): o motivo aparece na linha daquele arquivo, o lote continua com os outros e a vista fica aberta com o que não foi aceito', async () => {
    const { pg, b, envios } = await abrirCom();
    const lista = fotos(4);
    b.roteiroEnvio.push(E.erroDeEnvio(415, 'IMAGEM_FORMATO_NAO_SUPORTADO'), E.erroDeEnvio(400, 'IMAGEM_DIMENSOES_INVALIDAS'), E.erroDeEnvio(422, 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO'));
    await comArquivos(pg, lista);
    await E.enviarLote(pg, b);
    assert.equal(envios.length, 4);
    assert.match(linha(pg, lista[0]), /PNG, JPEG ou WebP/);
    assert.match(linha(pg, lista[1]), /320.*4096|4096.*320/s);
    assert.match(linha(pg, lista[2]), /tempo|demor|n[ãa]o foi poss[íi]vel processar/i);
    assert.equal(aberto(pg), true, 'a vista de envio continua aberta para a pessoa ver o que falhou');
    assert.equal(pg.textoDoDom().includes(E.TEXTO_DO_SERVIDOR), false);
    await E.botaoVoltar(pg).disparar('click');
    await pg.esperar();
    await E.irParaAba(pg, 'Minha Empresa');
    assert.deepEqual(E.pares(pg).sort(), ['EMPRESA:5001', 'EMPRESA:6001'], 'só a que foi aceita entrou na biblioteca');
  });

  test('PE-17 a imagem em andamento diz "enviando" e a tela não mostra sucesso antes da resposta; ao liberar, o lote termina', async () => {
    const { pg, b, envios } = await abrirCom();
    const lista = fotos(2);
    await comArquivos(pg, lista);
    const pausa = E.segurarEnvios(b);
    const clique = E.botaoEnviar(pg).disparar('click');
    await pg.esperar();
    assert.equal(b.emVoo, 1);
    assert.match(linha(pg, lista[0]), /enviando/i);
    assert.doesNotMatch(linha(pg, lista[1]), /enviando/i, 'a seguinte ainda não saiu');
    pausa.liberar();
    await clique;
    await E.aguardarEnvios(pg, b);
    assert.equal(envios.length, 2);
    assert.equal(aberto(pg), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 PE — quando o envio para: sessão, permissão, cota, limite e indisponibilidade (as seguintes não saem e nada é repetido sozinho)', () => {
  const PARADAS = [
    ['403 sem permissão', E.erroDeEnvio(403, 'SEM_PERMISSAO'), /permiss/i],
    ['409 cota de imagens da empresa', E.erroDeEnvio(409, 'IMAGEM_COTA_EXCEDIDA'), /cota|limite de imagens/i],
    ['429 limite de envios por minuto', E.erroDeEnvio(429, 'LIMITE_REQUISICOES_EXCEDIDO', { cabecalhos: { 'Retry-After': '30' } }), /muitas|aguarde|tentativas|limite/i],
    ['503 servidor ocupado', E.erroDeEnvio(503, 'IMAGENS_OCUPADO', { cabecalhos: { 'Retry-After': '5' } }), /ocupad|muitas imagens|tente novamente|aguarde/i],
    ['503 armazenamento indisponível', E.erroDeEnvio(503, 'IMAGENS_INDISPONIVEL'), /indispon/i],
  ];
  for (const [nome, resposta, texto] of PARADAS) {
    test(`PE-18 ${nome}: a primeira foi aceita, a segunda recebe o motivo, a terceira NÃO sai, e nenhum temporizador repete sozinho`, async () => {
      const { pg, b, envios } = await abrirCom();
      const lista = fotos(3);
      b.roteiroEnvio.push(null, resposta);
      await comArquivos(pg, lista);
      await E.enviarLote(pg, b);
      assert.equal(envios.length, 2, 'parou na segunda');
      assert.match(E.textoDoSeletor(pg), texto);
      assert.equal(pg.textoDoDom().includes(E.TEXTO_DO_SERVIDOR), false);
      assert.equal(aberto(pg), true, 'a vista continua aberta com o que sobrou');
      await pg.avancar();
      assert.equal(envios.length, 2, 'nenhuma repetição automática');
    });
  }

  test('PE-19 sessão encerrada (401) no meio do lote: volta ao Portal como em qualquer outra consulta e as seguintes não saem', async () => {
    const { pg, b, envios } = await abrirCom();
    b.roteiroEnvio.push(null, E.erroDeEnvio(401, 'NAO_AUTENTICADO'));
    await comArquivos(pg, fotos(3));
    await E.enviarLote(pg, b);
    assert.equal(envios.length, 2);
    assert.ok(pg.navegacoes.some((n) => /portal\//.test(n)), `volta ao Portal (${JSON.stringify(pg.navegacoes)})`);
  });

  test('PE-20 falha de rede no meio do lote: aquela imagem fica "incerta" (o servidor pode ter gravado), as seguintes não saem; ao pedir de novo vão só a incerta e as seguintes, com os MESMOS arquivos', async () => {
    const { pg, b, envios } = await abrirCom();
    const lista = fotos(3);
    b.roteiroEnvio.push(null, new TypeError('Failed to fetch'));
    await comArquivos(pg, lista);
    await E.enviarLote(pg, b);
    assert.equal(envios.length, 2);
    assert.match(linha(pg, lista[1]), /incert|n[ãa]o foi poss[íi]vel confirmar|pode ter sido/i);
    await pg.avancar();
    assert.equal(envios.length, 2, 'nada é repetido sozinho');
    const retomar = E.botaoPorNome(E.modal(pg), /Adicionar à biblioteca|Tentar novamente|Enviar novamente/i);
    assert.ok(retomar && !retomar.disabled, 'a pessoa pode tentar de novo');
    await retomar.disparar('click');
    await E.aguardarEnvios(pg, b);
    assert.deepEqual(envios.map((e) => e.nome), ['foto 1', 'foto 2', 'foto 2', 'foto 3'], 'a primeira, já aceita, não sai outra vez');
    assert.deepEqual(envios.map((e) => e.corpo), [lista[0], lista[1], lista[1], lista[2]]);
    assert.equal(b.empresa.length, 4);
  });

  test('PE-21 erro 5xx também deixa a imagem "incerta" (padrão do projeto: nada de repetição automática) e as seguintes não saem', async () => {
    const { pg, b, envios } = await abrirCom();
    const lista = fotos(2);
    b.roteiroEnvio.push(E.erroDeEnvio(500, 'ERRO_INTERNO'));
    await comArquivos(pg, lista);
    await E.enviarLote(pg, b);
    assert.equal(envios.length, 1);
    assert.match(linha(pg, lista[0]), /incert|n[ãa]o foi poss[íi]vel confirmar|pode ter sido/i);
    await pg.avancar();
    assert.equal(envios.length, 1);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 PE — nenhum envio em duplicidade', () => {
  test('PE-22 duplo clique em "Adicionar à biblioteca" (ou clique durante o envio) NÃO envia duas vezes: cada imagem sai uma vez e o botão fica indisponível enquanto o lote está em andamento', async () => {
    const { pg, b, envios } = await abrirCom();
    await comArquivos(pg, fotos(2));
    const pausa = E.segurarEnvios(b);
    const botao = E.botaoEnviar(pg);
    const primeiro = botao.disparar('click');
    await pg.esperar();
    assert.equal(b.emVoo, 1);
    assert.equal(E.acionavel(pg, botao), false, 'o botão não aceita outro clique durante o envio');
    await botao.disparar('click');
    await pg.esperar();
    assert.equal(b.emVoo + envios.length, 1, 'só uma requisição saiu até agora (a retida conta como em voo; o registro só nasce quando ela chega)');
    pausa.liberar();
    await primeiro;
    await E.aguardarEnvios(pg, b);
    assert.equal(envios.length, 2);
    assert.equal(b.maxEmVoo, 1);
  });

  test('PE-23 depois que o lote termina com sucesso, um novo clique não reenvia o que já foi aceito (a lista de envio foi encerrada)', async () => {
    const { pg, b, envios } = await abrirCom();
    await comArquivos(pg, fotos(2));
    await E.enviarLote(pg, b);
    assert.equal(envios.length, 2);
    await E.abrirEnvio(pg);
    assert.equal(E.botaoEnviar(pg).disabled, true, 'a lista recomeça vazia');
    await E.botaoEnviar(pg).disparar('click');
    await E.aguardarEnvios(pg, b);
    assert.equal(envios.length, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 PE — pop-up: fechar, foco e formulário do material', () => {
  test('PE-24 fechar o pop-up (Escape) com arquivos na lista descarta o lote; ao reabrir a vista é a da biblioteca, na aba "Todas", sem arquivos, e nada foi enviado', async () => {
    const { pg, envios } = await abrirCom();
    await comArquivos(pg, fotos(2));
    await H.pressionar(E.campoDeArquivos(pg), 'Escape');
    await pg.esperar();
    assert.equal(pg.el(IDS.modal).getAttribute('aria-hidden'), 'true');
    await H.abrirSeletor(pg);
    assert.deepEqual(E.abasAtivas(pg), ['Todas']);
    assert.equal(aberto(pg), false);
    assert.equal(botoesDeLinha(pg).filter((b) => pg.visivelNo(b)).length, 0);
    assert.equal(envios.length, 0);
  });

  test('PE-25 o foco acompanha a vista (protótipo V6): ao abrir o envio fica dentro do pop-up; "Voltar à biblioteca" o devolve ao botão "Adicionar imagens"; ao terminar o envio com sucesso vai para o título do seletor', async () => {
    const { pg, b } = await abrirCom();
    await E.abrirEnvio(pg);
    const ativo = pg.documento.activeElement;
    assert.ok(ativo && E.modal(pg).contains(ativo), 'o foco está dentro do pop-up');
    await E.botaoVoltar(pg).disparar('click');
    await pg.esperar();
    assert.ok(pg.documento.activeElement, 'depois de voltar há um elemento com o foco');
    assert.match(E.nomeAcessivel(pg.documento.activeElement), /Adicionar imagens/i);
    await E.abrirEnvio(pg);
    await E.escolherArquivos(pg, [foto(1)]);
    await E.enviarLote(pg, b);
    assert.equal(pg.foco(), 'imagemModalTitulo');
  });

  test('PE-26 o formulário do material não muda com o envio: valores, campo de imagem e escolha pendente ficam como estavam; nada do material é gravado', async () => {
    const { pg, b } = await abrirCom();
    await H.preencherCadastro(pg, { nome: 'Fita nova' });
    await E.escolherNoSeletor(pg, 'PADRAO', '1003');
    const formulario = H.estadoDoFormulario(pg);
    const campo = pg.texto(IDS.estado);
    await E.abrirEnvio(pg);
    await E.escolherArquivos(pg, [foto(1)]);
    await E.enviarLote(pg, b);
    await pg.clicar(IDS.cancelar);
    assert.deepEqual(H.estadoDoFormulario(pg), formulario);
    assert.equal(pg.texto(IDS.estado), campo);
    assert.equal(P.escritas(pg).length, 0);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 PE — higiene de segurança da vista de envio', () => {
  test('PE-27 nome de arquivo hostil vira texto: nenhum elemento é criado a partir dele, o campo de nome o traz como texto e a página não ganha montagem por innerHTML', async () => {
    const { pg } = await abrirCom();
    const hostil = E.arquivo({ nome: '<img src=x onerror=alert(1)>.png', semente: 'h' });
    const antes = pg.documento.usosDeInnerHTML.length;
    await comArquivos(pg, [hostil]);
    assert.equal(nomeDe(pg, hostil), '<img src=x onerror=alert(1)>');
    assert.equal(pg.consulta('img[src="x"]').length, 0);
    assert.equal(pg.consulta('[onerror]').length, 0);
    assert.equal(pg.documento.usosDeInnerHTML.length, antes);
  });

  test('PE-28 as prévias dos arquivos escolhidos são liberadas: ao tirar um da lista, ao voltar à biblioteca, ao fechar com Escape e ao terminar o envio nenhuma URL de objeto fica sem revogar', async () => {
    for (const saida of ['voltar', 'escape', 'concluir']) {
      const { pg, b, objetosDeUrl } = await abrirCom();
      const lista = fotos(3);
      await comArquivos(pg, lista);
      assert.ok(objetosDeUrl.criados.length >= 3, `${MARCA} a prévia de cada arquivo escolhido`);
      await E.itemDoArquivo(pg, lista[0]).remover.disparar('click');
      await pg.esperar();
      assert.ok(objetosDeUrl.revogados.length >= 1, 'tirar da lista libera a prévia daquele arquivo');
      if (saida === 'voltar') await E.botaoVoltar(pg).disparar('click');
      else if (saida === 'escape') await H.pressionar(E.campoDeArquivos(pg), 'Escape');
      else await E.enviarLote(pg, b);
      await pg.esperar();
      for (const url of objetosDeUrl.criados) assert.ok(objetosDeUrl.revogados.includes(url), `${saida}: a prévia ${url} continuou ativa`);
    }
  });

  test('PE-29 o envio não escreve nada no navegador (storage, cookie) nem no console: nomes de imagem e de arquivo ficam fora dos registros', async () => {
    const { pg, b } = await abrirCom();
    const lista = [E.arquivo({ nome: 'segredo-do-cliente.png', semente: 'c' })];
    const armazenamentoAntes = pg.storage.length;
    const cookiesAntes = pg.cookiesEscritos.length;
    await comArquivos(pg, lista);
    await E.digitarNome(pg, lista[0], 'Nome interno confidencial');
    await E.enviarLote(pg, b);
    assert.equal(pg.storage.length, armazenamentoAntes);
    assert.equal(pg.cookiesEscritos.length, cookiesAntes);
    assert.equal(/segredo-do-cliente|Nome interno confidencial/.test(JSON.stringify(pg.consoleChamadas)), false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 PE — pendentes: decisão de interface ainda não aprovada (viram testes na 5C-8 depois da aprovação)', () => {
  // PE-T01 (pré-checagem de dimensões, opcional) foi feita na 5C-8a e está coberta em imagens-material-empresa-envio-complemento.test.js (CP-01 a CP-06).
  test.todo('PE-T02 arrastar e soltar arquivos na zona de soltar do protótipo V6 (como localizar a zona pelo nome acessível)');
  test.todo('PE-T03 linha de cota "Sua empresa usa X de 300 imagens": de onde vem o X (total da listagem da empresa) e como a tela avisa que a cota está perto do fim');
  test.todo('PE-T04 cancelar ou fechar o pop-up com o envio em andamento: interromper o lote (AbortController), concluir em segundo plano ou bloquear o fechamento');
  test.todo('PE-T05 durante o envio: desabilitar ou apenas ignorar tirar da lista, editar nome, escolher mais arquivos e "Voltar à biblioteca"');
  test.todo('PE-T06 arquivo sem tipo MIME (alguns sistemas): recusar na tela, como hoje o servidor faria, ou deduzir o tipo pela extensão');
  test.todo('PE-T07 texto exato do resumo, dos estados por linha e da mensagem final (revisão de redação com o responsável)');
  test.todo('PE-T08 foco no primeiro item com problema ao terminar com erro e anúncio por leitor de tela (aria-live) dos resultados do lote');
  test.todo('PE-T09 espera depois de 429/503 com Retry-After (botão bloqueado por N segundos): o cabeçalho só é legível no navegador quando a página e a API são da mesma origem (CORS sem exposedHeaders)');
  test.todo('PE-T10 avisar, antes de enviar, que o arquivo já existe na biblioteca da empresa (comparação com as imagens já cadastradas, além da repetição dentro do lote)');
});

function exigirBotao(pg, regex) {
  return E.exigirBotao(E.modal(pg), regex, `botão ${regex} no seletor de imagens`);
}
