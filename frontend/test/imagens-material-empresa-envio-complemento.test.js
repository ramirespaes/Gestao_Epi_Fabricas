'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPagina } = require('./helpers/dom-pagina');
const E = require('./helpers/imagens-material-empresa');

/**
 * Unidade 5C-8a — comportamentos da implementação que os testes RED da 5C-7 não cobrem: a pré-checagem de dimensões (opcional: só orienta quando o navegador sabe
 * decodificar, nunca bloqueia sem recurso), o que fica travado durante um envio, a sessão encerrada no meio do lote, a releitura da biblioteca que falha depois de um envio
 * bom, escolhas de arquivos em sequência e a repetição dinâmica dentro do lote. Páginas reais no harness de DOM, biblioteca simulada com estado, sem PostgreSQL e sem API.
 */

const { H } = E;
const { IDS } = H;

const EMPRESA = [{ id: '5001', nome: 'Luva da empresa', versao: 1 }];
const abrirCom = (empresa = EMPRESA, extra = {}) => E.abrir({ biblioteca: E.criarBiblioteca({ empresa, proximoId: 6001 }), ...extra });
const foto = (n) => E.arquivo({ nome: `foto-${n}.png`, tipo: 'image/png', semente: `cp-${n}` });
const comArquivos = async (pg, lista) => {
  await E.abrirEnvio(pg);
  await E.escolherArquivos(pg, lista);
};
const linha = (pg, arquivo) => E.textoDoItem(pg, arquivo);
const botoesDeLinha = (pg) => E.modal(pg).querySelectorAll('button').filter((b) => /^Tirar .+ da lista$/.test(E.nomeAcessivel(b)));

/** Uma página mínima só com o campo da imagem e os três módulos: dá acesso direto à API do módulo (habilitar, encerrar) dentro do harness de DOM. */
const pagina = (comEnvio) => `<html><head></head><body>
  <div id="campoImagemMaterial"><div id="imagemMaterialPrevia"></div><div id="imagemMaterialEstado" role="status"></div>
    <button id="botaoRemoverImagem" type="button" hidden></button><button id="botaoEscolherImagem" type="button">Escolher imagem</button></div>
  <script src="../js/api-http.js"></script>${comEnvio ? '\n  <script src="../js/imagens-envio.js"></script>' : ''}
  <script src="../js/imagens-material.js"></script>
</body></html>`;

async function abrirMinima({ comEnvio = true, empresa = EMPRESA, respostas = {} } = {}) {
  const sv = E.servidor({ biblioteca: E.criarBiblioteca({ empresa, proximoId: 6001 }), respostas });
  const pg = abrirPagina('pages/materials.html', { html: pagina(comEnvio), rotas: sv.rotas });
  await pg.esperar();
  E.instalarEnvio(pg, sv.biblioteca);
  const api = pg.janela.EpiImagensMaterial.montar({ documento: pg.documento, aoSessaoEncerrada: () => { pg.janela.sessaoFoiEncerrada = true; } });
  return { pg, api, b: sv.biblioteca, envios: sv.biblioteca.envios };
}

const comDecodificador = async (decodificar, fn) => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'createImageBitmap');
  Object.defineProperty(globalThis, 'createImageBitmap', { value: decodificar, configurable: true, writable: true });
  try {
    return await fn();
  } finally {
    if (original) Object.defineProperty(globalThis, 'createImageBitmap', original);
    else delete globalThis.createImageBitmap;
  }
};

// ─────────────────────────────────────────────────────────────────────
describe('5C-8a CP — pré-checagem de dimensões: só orienta, nunca bloqueia sem recurso', () => {
  test('CP-01 medirDimensoes devolve largura e altura (e fecha o bitmap) quando o navegador decodifica; sem decodificador, com erro de leitura ou com medidas inválidas devolve nulo, sem lançar', async () => {
    const { medirDimensoes } = E.envio('medição opcional das dimensões');
    const arq = E.arquivo({ nome: 'a.png' });
    let fechados = 0;
    await comDecodificador(async () => ({ width: 800, height: 600, close() { fechados += 1; } }), async () => {
      assert.deepEqual(await medirDimensoes(arq), { largura: 800, altura: 600 });
    });
    assert.equal(fechados, 1, 'o bitmap é fechado');
    assert.equal(await medirDimensoes(arq), null, 'sem decodificador');
    await comDecodificador(async () => { throw new Error('arquivo corrompido'); }, async () => assert.equal(await medirDimensoes(arq), null));
    for (const ruim of [{ width: 0, height: 10 }, { width: 10.5, height: 10 }, { width: Number.NaN, height: 10 }, { width: '10', height: 10 }, {}]) {
      await comDecodificador(async () => ruim, async () => assert.equal(await medirDimensoes(arq), null, JSON.stringify(ruim)));
    }
    assert.equal(await medirDimensoes(null), null);
    assert.equal(await medirDimensoes({ name: 'x.png' }), null);
  });

  test('CP-02 validarDimensoes segue a regra do servidor: menor lado ≥ 320, maior lado ≤ 4096 e até 8.388.608 pixels (o teto exato é aceito)', () => {
    const { validarDimensoes } = E.envio('validação das dimensões');
    const veredito = (largura, altura) => validarDimensoes({ largura, altura });
    const PEQUENA = { ok: false, codigo: 'DIMENSOES_PEQUENAS' };
    const GRANDE = { ok: false, codigo: 'DIMENSOES_GRANDES' };
    assert.deepEqual(veredito(320, 320), { ok: true });
    assert.deepEqual(veredito(4096, 2048), { ok: true });
    assert.deepEqual(veredito(2048, 4096), { ok: true });
    assert.deepEqual(veredito(319, 4000), PEQUENA);
    assert.deepEqual(veredito(4000, 100), PEQUENA);
    assert.deepEqual(veredito(4097, 400), GRANDE);
    assert.deepEqual(veredito(4096, 4096), GRANDE);
    assert.deepEqual(veredito(4096, 2049), GRANDE);
    for (const ruim of [null, undefined, {}, { largura: 0, altura: 1 }, { largura: 1.5, altura: 10 }, { largura: '10', altura: 10 }]) assert.throws(() => validarDimensoes(ruim), TypeError, JSON.stringify(ruim));
  });

  test('CP-03 os textos das dimensões recusadas dizem os limites reais', () => {
    const { mensagens } = E.envio('textos das dimensões');
    assert.match(mensagens.deArquivo('DIMENSOES_PEQUENAS'), /320/);
    assert.match(mensagens.deArquivo('DIMENSOES_GRANDES'), /4096/);
    assert.match(mensagens.deArquivo('DIMENSOES_GRANDES'), /8 megapixels/);
  });

  test('CP-04 com decodificador no navegador: dimensões fora do permitido são recusadas na tela (sem gastar um envio) e as boas mostram "L×A px" e seguem', async () => {
    const { pg, b, envios } = await abrirCom();
    const medidas = { 'pequena.png': [200, 200], 'larga.png': [5000, 400], 'enorme.png': [4096, 4096], 'boa.png': [800, 600] };
    pg.janela.createImageBitmap = async (arq) => ({ width: medidas[arq.name][0], height: medidas[arq.name][1], close() {} });
    const lista = Object.keys(medidas).map((nome) => E.arquivo({ nome, semente: nome }));
    await comArquivos(pg, lista);
    assert.match(linha(pg, lista[0]), /320/);
    assert.match(linha(pg, lista[1]), /4096/);
    assert.match(linha(pg, lista[2]), /4096|megapixels/);
    assert.match(linha(pg, lista[3]), /800×600 px/);
    for (const recusada of lista.slice(0, 3)) assert.equal(E.itemDoArquivo(pg, recusada).nomeInput, null);
    assert.match(E.textoDoSeletor(pg), /1 prontas?\b/i);
    assert.match(E.textoDoSeletor(pg), /3 recusadas?\b/i);
    await E.enviarLote(pg, b);
    assert.deepEqual(envios.map((e) => e.nome), ['boa']);
  });

  test('CP-05 decodificador que falha em UM arquivo não bloqueia nada: ele segue como pronto, sem medidas, e o servidor decide', async () => {
    const { pg, b, envios } = await abrirCom();
    pg.janela.createImageBitmap = async (arq) => {
      if (arq.name === 'quebrada.png') throw new Error('não decodifica');
      return { width: 640, height: 480, close() {} };
    };
    const lista = [E.arquivo({ nome: 'quebrada.png', semente: 'q' }), E.arquivo({ nome: 'normal.png', semente: 'n' })];
    await comArquivos(pg, lista);
    assert.doesNotMatch(linha(pg, lista[0]), /\d+×\d+ px/);
    assert.match(linha(pg, lista[1]), /640×480 px/);
    assert.match(E.textoDoSeletor(pg), /2 prontas?\b/i);
    await E.enviarLote(pg, b);
    assert.deepEqual(envios.map((e) => e.nome), ['quebrada', 'normal']);
  });

  test('CP-06 sem decodificador (o caso do navegador sem createImageBitmap): nenhuma medida inventada e nada bloqueado', async () => {
    const { pg } = await abrirCom();
    const lista = [foto(1), foto(2)];
    await comArquivos(pg, lista);
    for (const arq of lista) assert.doesNotMatch(linha(pg, arq), /\d+×\d+ px/);
    assert.match(E.textoDoSeletor(pg), /2 prontas?\b/i);
    assert.equal(E.botaoEnviar(pg).disabled, false);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-8a CP — durante o envio nada altera o lote e a tela não fecha no meio', () => {
  test('CP-07 com o envio em andamento: Escape, "×", "Voltar", escolher arquivos, tirar da lista e editar nomes ficam indisponíveis; terminado com uma recusa, os controles voltam', async () => {
    const { pg, b } = await abrirCom();
    const lista = [foto(1), foto(2)];
    b.roteiroEnvio.push(null, E.erroDeEnvio(415, 'IMAGEM_FORMATO_NAO_SUPORTADO'));
    await comArquivos(pg, lista);
    const pausa = E.segurarEnvios(b);
    const clique = E.botaoEnviar(pg).disparar('click');
    await pg.esperar();
    await H.pressionar(E.campoDeArquivos(pg), 'Escape');
    await pg.esperar();
    assert.equal(pg.el(IDS.modal).getAttribute('aria-hidden'), 'false', 'Escape não fecha no meio do envio');
    assert.equal(E.acionavel(pg, pg.el('botaoImagemEnvioFechar')), false);
    assert.equal(E.acionavel(pg, E.botaoVoltar(pg)), false);
    assert.equal(E.acionavel(pg, pg.el('botaoImagemSelecionarArquivos')), false);
    assert.equal(E.campoDeArquivos(pg).disabled, true);
    for (const arq of lista) {
      const { remover, nomeInput } = E.itemDoArquivo(pg, arq);
      assert.equal(remover.disabled, true, `tirar ${arq.name}`);
      assert.equal(nomeInput.disabled, true, `nome de ${arq.name}`);
    }
    pausa.liberar();
    await clique;
    await E.aguardarEnvios(pg, b);
    assert.equal(pg.el(IDS.modal).getAttribute('aria-hidden'), 'false');
    assert.equal(E.acionavel(pg, E.botaoVoltar(pg)), true, 'terminado, dá para voltar');
    assert.equal(E.acionavel(pg, pg.el('botaoImagemEnvioFechar')), true);
    assert.equal(E.itemDoArquivo(pg, lista[1]).remover.disabled, false);
    await H.pressionar(E.campoDeArquivos(pg), 'Escape');
    await pg.esperar();
    assert.equal(pg.el(IDS.modal).getAttribute('aria-hidden'), 'true', 'agora Escape fecha');
  });

  test('CP-08 sessão encerrada no meio do envio (encerrar): o pop-up fecha, a lista de envio some e a resposta tardia não escreve nada na tela nem chama o Portal', async () => {
    const { pg, api, b } = await abrirMinima();
    api.habilitar(true, { enviar: true });
    await comArquivos(pg, [foto(1), foto(2)]);
    const pausa = E.segurarEnvios(b);
    const clique = E.botaoEnviar(pg).disparar('click');
    await pg.esperar();
    api.encerrar();
    pausa.liberar();
    await clique;
    await E.aguardarEnvios(pg, b);
    assert.equal(pg.el(IDS.modal).getAttribute('aria-hidden'), 'true');
    assert.equal(pg.el('imagemEnvioLista').children.length, 0);
    assert.equal(pg.janela.sessaoFoiEncerrada, undefined, 'a resposta tardia não dispara nada');
    await H.abrirSeletor(pg);
    assert.equal(E.naoVisivel(pg, E.campoDeArquivos(pg)), true, 'reabre na biblioteca');
    assert.equal(pg.visivel('imagemAvisoLote'), false);
  });

  test('CP-09 se a permissão de enviar some com o pop-up na vista de envio (e nada em andamento), a tela volta à biblioteca e o "Adicionar imagens" some; sem permissão nenhuma o pop-up fecha', async () => {
    const { pg, api } = await abrirMinima();
    api.habilitar(true, { enviar: true });
    await comArquivos(pg, [foto(1)]);
    api.habilitar(true, { enviar: false });
    await pg.esperar();
    assert.equal(E.naoVisivel(pg, E.campoDeArquivos(pg)), true, 'saiu da vista de envio');
    assert.equal(E.acionavel(pg, E.botaoAdicionar(pg)), false);
    assert.equal(E.objetosDeUrl.criados.every((u) => E.objetosDeUrl.revogados.includes(u)), true, 'as miniaturas foram liberadas');
    api.habilitar(false);
    assert.equal(pg.el(IDS.modal).getAttribute('aria-hidden'), 'true');
  });

  test('CP-10 sem o módulo de envio carregado a seleção continua funcionando (abas e pesquisa) e o "Adicionar imagens" nunca aparece', async () => {
    const { pg, api } = await abrirMinima({ comEnvio: false });
    api.habilitar(true, { enviar: true });
    await H.abrirSeletor(pg);
    E.exigirAbas(pg);
    assert.equal(E.acionavel(pg, E.botaoAdicionar(pg)), false);
    await E.irParaAba(pg, 'Minha Empresa');
    assert.deepEqual(E.pares(pg), ['EMPRESA:5001']);
    assert.doesNotMatch(E.estadoDoSeletor(pg), /Adicionar imagens/);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-8a CP — escolhas de arquivos em sequência, repetição dinâmica e o fim do envio', () => {
  test('CP-11 o nome digitado numa linha sobrevive a novas escolhas de arquivos (a lista é redesenhada, o estado não se perde)', async () => {
    const { pg } = await abrirCom();
    const [a, b] = [foto(1), foto(2)];
    await comArquivos(pg, [a]);
    await E.digitarNome(pg, a, 'Nome que eu digitei');
    await E.escolherArquivos(pg, [b]);
    assert.equal(E.itemDoArquivo(pg, a).nomeInput.value, 'Nome que eu digitei');
    assert.equal(E.itemDoArquivo(pg, b).nomeInput.value, 'foto 2');
  });

  test('CP-12 duas escolhas seguidas, sem esperar a leitura da primeira, respeitam o limite de 10 e mantêm a ordem', async () => {
    const { pg } = await abrirCom();
    await E.abrirEnvio(pg);
    const campo = E.campoDeArquivos(pg);
    const primeiras = Array.from({ length: 8 }, (_, i) => foto(i + 1));
    const segundas = Array.from({ length: 5 }, (_, i) => foto(i + 9));
    campo.files = primeiras;
    const primeira = campo.disparar('change');
    campo.files = segundas;
    const segunda = campo.disparar('change');
    await Promise.all([primeira, segunda]);
    await E.aguardar(pg);
    assert.deepEqual(botoesDeLinha(pg).map(E.nomeAcessivel), [...primeiras, ...segundas].slice(0, 10).map((a) => `Tirar ${a.name} da lista`));
    assert.match(E.textoDoSeletor(pg), /limite.*10/i);
  });

  test('CP-13 a repetição é dinâmica: se a PRIMEIRA das duas imagens iguais sai da lista, a outra passa a ser enviada (nenhuma imagem fica de fora)', async () => {
    const { pg, b, envios } = await abrirCom();
    const a = E.arquivo({ nome: 'original.png', semente: 'igual' });
    const copia = E.arquivo({ nome: 'copia.png', semente: 'igual' });
    await comArquivos(pg, [a, copia]);
    assert.match(linha(pg, copia), /mesma imagem/i);
    await E.itemDoArquivo(pg, a).remover.disparar('click');
    await pg.esperar();
    assert.doesNotMatch(linha(pg, copia), /mesma imagem/i);
    assert.match(E.textoDoSeletor(pg), /1 prontas?\b/i);
    await E.enviarLote(pg, b);
    assert.equal(envios.length, 1);
    assert.equal(envios[0].corpo, copia);
  });

  test('CP-14 o envio deu certo mas a releitura da biblioteca falha: o aviso do que foi adicionado aparece, o seletor diz que a biblioteca está indisponível e nada quebra', async () => {
    let consultas = 0;
    const segundaConsultaFalha = (c, regra) => { consultas += 1; return consultas === 1 ? regra(c) : { status: 503, corpo: { status: 'error', codigo: 'IMAGENS_INDISPONIVEL', message: E.TEXTO_DO_SERVIDOR } }; };
    const { pg, b } = await abrirCom(EMPRESA, { respostas: { 'GET /imagens-material': segundaConsultaFalha } });
    await comArquivos(pg, [foto(1)]);
    await E.enviarLote(pg, b);
    assert.deepEqual(E.abasAtivas(pg), ['Minha Empresa']);
    assert.match(pg.texto('imagemAvisoLote'), /1 imagem adicionada/);
    assert.match(E.estadoDoSeletor(pg), /indispon/i);
    assert.equal(pg.textoDoDom().includes(E.TEXTO_DO_SERVIDOR), false);
    assert.equal(b.empresa.length, 2);
  });

  test('CP-15 o aviso do lote ao parar por limite ou ocupação cita a espera só quando o navegador a deixou ler (o Retry-After pode estar oculto pelo CORS)', async () => {
    const com = await abrirCom();
    com.b.roteiroEnvio.push(E.erroDeEnvio(429, 'LIMITE_REQUISICOES_EXCEDIDO', { cabecalhos: { 'Retry-After': '30' } }));
    await comArquivos(com.pg, [foto(1)]);
    await E.enviarLote(com.pg, com.b);
    assert.match(com.pg.texto('imagemEnvioMensagem'), /Muitas imagens/);
    assert.match(com.pg.texto('imagemEnvioMensagem'), /30 segundos/);
    const sem = await abrirCom();
    sem.b.roteiroEnvio.push(E.erroDeEnvio(429, 'LIMITE_REQUISICOES_EXCEDIDO'));
    await comArquivos(sem.pg, [foto(1)]);
    await E.enviarLote(sem.pg, sem.b);
    assert.match(sem.pg.texto('imagemEnvioMensagem'), /Muitas imagens/);
    assert.doesNotMatch(sem.pg.texto('imagemEnvioMensagem'), /segundos/);
  });

  test('CP-16 401 numa página SEGUINTE da listagem também devolve ao Portal, e o que já veio continua escolhível', async () => {
    const segundaPagina401 = (c, regra) => (new URL(c.url).searchParams.get('pagina') === '2' ? { status: 401, corpo: { status: 'error', codigo: 'NAO_AUTENTICADO', message: E.TEXTO_DO_SERVIDOR } } : regra(c));
    const { pg } = await abrirCom(E.empresaN(90), { respostas: { 'GET /imagens-material': segundaPagina401 } });
    await H.abrirSeletor(pg);
    assert.ok(pg.navegacoes.some((n) => /portal\//.test(n)), JSON.stringify(pg.navegacoes));
    assert.equal(E.pares(pg).length, 100);
  });

  test('CP-17 miniaturas locais: arquivo recusado na tela não ganha miniatura (nenhuma URL de objeto à toa) e miniatura que não carrega vira o ícone, sem quebrar a linha', async () => {
    const { pg, objetosDeUrl } = await abrirCom();
    const boa = foto(1);
    const gif = E.arquivo({ nome: 'figura.gif', tipo: 'image/gif', semente: 'g' });
    await comArquivos(pg, [boa, gif]);
    assert.equal(objetosDeUrl.criados.length, 1, 'só o arquivo aceito ganha miniatura');
    const item = E.itemDoArquivo(pg, boa).item;
    assert.equal(item.querySelectorAll('img').length, 1);
    await H.falharImagem(item.querySelector('img'));
    await pg.esperar();
    assert.equal(E.itemDoArquivo(pg, boa).item.querySelectorAll('img').length, 0, 'a miniatura quebrada sai');
    assert.equal(E.itemDoArquivo(pg, boa).nomeInput.value, 'foto 1', 'a linha segue utilizável');
  });

  test('CP-18 fechar o pop-up depois de um envio PARCIAL (uma imagem criada, outra recusada) e abrir de novo: a biblioteca é lida outra vez e a imagem criada aparece', async () => {
    const { pg, b } = await abrirCom();
    const [boa, ruim] = [foto(1), foto(2)];
    b.roteiroEnvio.push(null, E.erroDeEnvio(415, 'IMAGEM_FORMATO_NAO_SUPORTADO'));
    await comArquivos(pg, [boa, ruim]);
    await E.enviarLote(pg, b);
    assert.equal(E.naoVisivel(pg, E.campoDeArquivos(pg)), false, 'a vista de envio segue aberta com a recusa');
    await H.pressionar(E.campoDeArquivos(pg), 'Escape');
    await pg.esperar();
    const antes = E.chamadasDaLista(pg).length;
    await H.abrirSeletor(pg);
    assert.ok(E.chamadasDaLista(pg).length > antes, 'a lista guardada estava velha: lê de novo');
    await E.irParaAba(pg, 'Minha Empresa');
    assert.deepEqual(E.pares(pg).sort(), ['EMPRESA:5001', 'EMPRESA:6001']);
  });

  test('CP-19 um erro inesperado ao ler um arquivo não trava as escolhas seguintes: aparece o aviso, nenhuma vaga fica contada à toa e o próximo arquivo entra normalmente', async () => {
    const { pg } = await abrirCom();
    const quebrado = { get name() { throw new Error('arquivo ilegível'); }, size: 10, type: 'image/png' };
    await E.abrirEnvio(pg);
    await E.escolherArquivos(pg, [quebrado]);
    assert.match(pg.texto('imagemEnvioMensagem'), /Não foi possível ler os arquivos/);
    assert.equal(botoesDeLinha(pg).length, 0);
    const lista = Array.from({ length: 10 }, (_, i) => foto(i + 1));
    await E.escolherArquivos(pg, lista);
    assert.equal(botoesDeLinha(pg).length, 10, 'as 10 vagas estavam livres');
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-8a CP — reabrir o seletor, resposta antiga da lista, página repetida e a trava do botão oculto (lacunas achadas pela mutação focalizada)', () => {
  test('CP-20 depois de um envio que levou à aba Minha Empresa, fechar e abrir de novo volta à aba Todas, com a biblioteca inteira', async () => {
    const { pg, b } = await abrirCom();
    await comArquivos(pg, [foto(1)]);
    await E.enviarLote(pg, b);
    assert.deepEqual(E.abasAtivas(pg), ['Minha Empresa']);
    await pg.clicar(IDS.cancelar);
    await pg.esperar();
    await H.abrirSeletor(pg);
    assert.deepEqual(E.abasAtivas(pg), ['Todas']);
    assert.equal(E.pares(pg).length, H.imagensPadrao().length + 2, 'a biblioteca inteira, não só a da empresa');
  });

  test('CP-21 a pesquisa digitada é limpa ao reabrir o seletor e a lista volta inteira', async () => {
    const { pg } = await abrirCom();
    await H.abrirSeletor(pg);
    const total = E.pares(pg).length;
    await pg.digitar(IDS.busca, 'luva');
    await pg.esperar();
    assert.ok(E.pares(pg).length < total, 'a pesquisa filtrou');
    await pg.clicar(IDS.cancelar);
    await pg.esperar();
    await H.abrirSeletor(pg);
    assert.equal(pg.el(IDS.busca).value, '');
    assert.equal(E.pares(pg).length, total);
  });

  test('CP-22 a resposta antiga da lista (de uma abertura fechada antes de ela chegar) é descartada quando chega depois da nova', async () => {
    const antiga = E.segurar({ status: 200, corpo: { status: 'ok', imagens: [{ origem: 'EMPRESA', id: '9999', nome: 'Imagem antiga', versao: 1 }], total: 1, pagina: 1, limite: 100 } });
    let consultas = 0;
    const emOrdem = (c, regra) => { consultas += 1; return consultas === 1 ? antiga.espera : regra(c); };
    const { pg } = await abrirCom(EMPRESA, { respostas: { 'GET /imagens-material': emOrdem } });
    const primeira = pg.el(IDS.escolher).disparar('click');
    await pg.esperar();
    await pg.clicar(IDS.cancelar);
    await pg.esperar();
    await H.abrirSeletor(pg);
    const nova = E.pares(pg);
    assert.equal(consultas, 2);
    assert.ok(nova.includes('EMPRESA:5001'));
    antiga.liberar();
    await primeira;
    await pg.esperar();
    assert.deepEqual(E.pares(pg), nova, 'a lista nova continua a mesma');
    assert.equal(E.pares(pg).includes('EMPRESA:9999'), false, 'a resposta antiga não a substituiu');
  });

  test('CP-23 com a imagem já escolhida marcada, "Salvar imagem selecionada" fica desabilitado; marcar outra habilita e voltar à mesma desabilita de novo', async () => {
    const { pg } = await abrirCom();
    await E.escolherNoSeletor(pg, 'EMPRESA', '5001');
    await H.abrirSeletor(pg);
    assert.deepEqual(E.paresMarcados(pg), ['EMPRESA:5001']);
    assert.equal(pg.el(IDS.confirmar).disabled, true, 'nada mudou em relação ao campo');
    await H.itens(pg).find((e) => E.par(e).startsWith('PADRAO:')).disparar('click');
    await pg.esperar();
    assert.equal(pg.el(IDS.confirmar).disabled, false);
    await H.itens(pg).find((e) => E.par(e) === 'EMPRESA:5001').disparar('click');
    await pg.esperar();
    assert.equal(pg.el(IDS.confirmar).disabled, true, 'de volta à imagem já escolhida');
  });

  test('CP-24 uma listagem que devolve a MESMA página de novo (nenhum item novo) não é seguida por dezenas de consultas: para na segunda e avisa que a lista pode estar incompleta', async () => {
    const pagina100 = E.empresaN(100).map((i) => ({ origem: 'EMPRESA', id: i.id, nome: i.nome, versao: i.versao }));
    const sempreIgual = () => ({ status: 200, corpo: { status: 'ok', imagens: pagina100, total: 250, pagina: 1, limite: 100 } });
    const { pg } = await abrirCom(EMPRESA, { respostas: { 'GET /imagens-material': sempreIgual } });
    await H.abrirSeletor(pg);
    assert.equal(E.chamadasDaLista(pg).length, 2, 'a segunda página não trouxe nada novo: parar');
    assert.equal(E.pares(pg).length, 100);
    assert.match(E.estadoDoSeletor(pg), /incompleta/i);
  });

  test('CP-25 sem materials.criar, o clique forçado no "Adicionar imagens" oculto não abre a vista de envio (a trava não depende só de esconder o botão)', async () => {
    const { pg, api } = await abrirMinima();
    api.habilitar(true, { enviar: false });
    await H.abrirSeletor(pg);
    const botao = E.botaoAdicionar(pg);
    assert.equal(E.naoVisivel(pg, botao), true, 'o botão está oculto');
    await botao.disparar('click');
    await pg.esperar();
    assert.equal(E.naoVisivel(pg, E.campoDeArquivos(pg)), true, 'a vista de envio continua fechada');
  });
});
