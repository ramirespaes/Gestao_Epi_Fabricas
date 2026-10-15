'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const H = require('./helpers/totem-i');
const { RAIZ } = require('./helpers/dom-pagina');

/**
 * Etapa I — I-G2: testes NOVOS do incremento (ordem de inicialização, ativação incerta, separação das duas credenciais,
 * encerramento e limpeza, limites da identificação). Todos TESTADOS COM MOCKS: o servidor é o falso do helper, fiel aos
 * contratos C e D; nenhum serviço real é tocado.
 */

const { TEXTOS, FUNCIONARIOS } = H;
const [ANA, BRUNO] = FUNCIONARIOS;
const ATIVAR = `POST ${H.BASE}/ativar`;
const ESTADO = `GET ${H.BASE}/estado`;
const ATENDIMENTO_GET = `GET ${H.BASE}/atendimento`;
const IDENT = `POST ${H.BASE}/atendimento`;
const ENCERRAR = `POST ${H.BASE}/atendimento/encerrar`;
// Texto de orientação pedido pela V5 para a ativação sem resultado confirmado (ainda fora do catálogo aprovado de textos).
const ATIVACAO_INCERTA = 'Não conseguimos confirmar a ativação deste tablet. Se o problema continuar, procure a administração do sistema e peça um novo código.';

const novo = (tablet = 'nao_autorizado') => {
  const codigo = H.novoToken();
  return { codigo, servidor: H.criarServidor({ tablet, codigos: { [codigo]: 'valido' } }) };
};
const comFragmento = (codigo, servidor, extra = {}) => H.abrirTotem({ servidor, hash: `#ativar=${codigo}`, ...extra });

describe('[G2-A] ordem de inicialização: o fragmento sai da URL antes de qualquer outro script', () => {
  test('[G2-01] o primeiro script executado é o de inicialização, que ainda vê o fragmento; todos os demais já o veem removido', async () => {
    const { codigo, servidor } = novo();
    const transformar = (relativo, fonte) => `(window.__ordem = window.__ordem || []).push({ s: ${JSON.stringify(relativo)}, h: window.location.hash });\n${fonte}`;
    const t = await comFragmento(codigo, servidor, { transformar });
    const ordem = H.plano(t.janela.__ordem);
    assert.equal(ordem[0].s, 'totem/boot.js', JSON.stringify(ordem));
    assert.equal(ordem[0].h, `#ativar=${codigo}`);
    assert.ok(ordem.length >= 2, 'há outros scripts depois do inicial');
    for (const o of ordem.slice(1)) assert.equal(o.h, '', `o script ${o.s} viu o fragmento`);
    const iReplace = t.eventos.findIndex((e) => e.tipo === 'replaceState');
    assert.notEqual(iReplace, -1);
    assert.ok(t.eventos.slice(0, iReplace).every((e) => e.tipo !== 'fetch'), 'nenhuma requisição antes da remoção');
    assert.equal(servidor.chamadas.length, 0, 'com um código a página não faz nenhuma chamada ao ler o fragmento');
  });

  test('[G2-02] nenhum script do Totem lê o endereço da página (hash, href, search) nem cookie: só o de inicialização toca no fragmento', () => {
    const { boot, js } = H.corpus();
    for (const [nome, codigo] of [['totem.js', js], ['boot.js', boot]]) {
      const limpo = codigo.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      // O boot.js precisa de pathname e search para reescrever a URL sem o fragmento; o totem.js não lê o endereço.
      const proibido = nome === 'boot.js' ? /location\.href|document\.URL|document\.referrer|document\.cookie/ : /location\.(href|search|pathname)|document\.URL|document\.referrer|document\.cookie/;
      assert.ok(!proibido.test(limpo), `${nome} lê o endereço ou cookies`);
      if (nome === 'totem.js') assert.ok(!/location\.hash/.test(limpo), 'totem.js não lê o fragmento');
    }
  });

  test('[G2-03] o código não fica em variável global nem em propriedade enumerável da janela', async () => {
    const { codigo, servidor } = novo();
    const t = await comFragmento(codigo, servidor);
    const achados = Object.entries(t.janela).filter(([, v]) => { try { return JSON.stringify(v)?.includes(codigo); } catch { return false; } }).map(([k]) => k);
    assert.deepEqual(achados, []);
    assert.deepEqual(H.vazamentos(t, { codigo }), []);
  });
});

describe('[G2-B] ativação sem resultado confirmado (resposta perdida, tempo esgotado, conexão interrompida)', () => {
  test('[G2-10] falha de rede depois do toque: não afirma ativação nem falha, não repete sozinha, oferece a orientação neutra e mantém só o toque manual', async () => {
    const { codigo, servidor } = novo();
    const t = await comFragmento(codigo, servidor);
    servidor.falhar(ATIVAR, 'rede');
    await t.clicarTexto(TEXTOS.ativacaoBotao);
    const texto = t.textoVisivel();
    assert.ok(texto.includes(TEXTOS.comunicacao));
    assert.ok(texto.includes(ATIVACAO_INCERTA));
    assert.ok(!texto.includes(TEXTOS.ativacaoFalha), 'não declara que o código é inválido');
    assert.ok(!texto.includes(TEXTOS.identifique), 'não declara o tablet ativado');
    assert.deepEqual(t.telaAtual(), ['telaAtivacao']);
    await t.passar(120000, 10000);
    assert.equal(servidor.contar(ATIVAR), 1, 'nenhuma repetição automática do código de uso único');
    assert.deepEqual(servidor.violacoes, []);
    assert.deepEqual(H.vazamentos(t, { codigo }), []);
  });

  test('[G2-11] tempo esgotado (sem resposta): vira resultado incerto no limite, sem repetição automática', async () => {
    const { codigo, servidor } = novo();
    const t = await comFragmento(codigo, servidor);
    servidor.falhar(ATIVAR, 'pendente');
    await t.clicarEl(t.botao(TEXTOS.ativacaoBotao));
    assert.ok(!t.textoVisivel().includes(TEXTOS.comunicacao), 'antes do limite ainda está aguardando');
    assert.ok(t.botao(TEXTOS.ativacaoBotao)?.disabled, 'enquanto aguarda não há segundo envio');
    await t.passar(15000, 1000);
    const texto = t.textoVisivel();
    assert.ok(texto.includes(TEXTOS.comunicacao));
    assert.ok(texto.includes(ATIVACAO_INCERTA));
    assert.ok(!texto.includes(TEXTOS.ativacaoFalha));
    await t.passar(60000, 10000);
    assert.equal(servidor.contar(ATIVAR), 1);
  });

  test('[G2-12] resposta perdida com a ativação aplicada no servidor: a única recuperação é a consulta de estado da Etapa C; autorizado, segue para a identificação sem novo envio', async () => {
    const { codigo, servidor } = novo();
    const t = await comFragmento(codigo, servidor);
    servidor.falhar(ATIVAR, 'perdida');
    await t.clicarTexto(TEXTOS.ativacaoBotao);
    assert.equal(servidor.contar(ESTADO), 1, 'consulta de recuperação');
    assert.equal(servidor.tablet, 'ativo');
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.equal(servidor.contar(ATIVAR), 1);
    assert.deepEqual(H.vazamentos(t, { codigo }), []);
  });

  test('[G2-13] sem recuperação comprovada (estado ainda não autorizado) o tablet continua na ativação com a orientação neutra', async () => {
    const { codigo, servidor } = novo();
    const t = await comFragmento(codigo, servidor);
    servidor.falhar(ATIVAR, 'rede');
    await t.clicarTexto(TEXTOS.ativacaoBotao);
    assert.equal(servidor.contar(ESTADO), 1);
    assert.deepEqual(t.telaAtual(), ['telaAtivacao']);
    assert.equal(servidor.tablet, 'nao_autorizado');
  });

  test('[G2-14] erro recebido e interpretado (401) é definitivo: não repete, não tenta recuperar e descarta o código', async () => {
    const codigo = H.novoToken();
    const servidor = H.criarServidor({ tablet: 'nao_autorizado', codigos: { [codigo]: 'usado' } });
    const t = await comFragmento(codigo, servidor);
    await t.clicarTexto(TEXTOS.ativacaoBotao);
    assert.ok(t.textoVisivel().includes(TEXTOS.ativacaoFalha));
    assert.equal(servidor.contar(ESTADO), 0, 'resposta conhecida: nada a recuperar');
    await t.clicarTexto(TEXTOS.ativacaoBotao);
    assert.equal(servidor.contar(ATIVAR), 1);
  });

  test('[G2-15] segundo toque enquanto o primeiro envio aguarda resposta não gera segundo POST', async () => {
    const { codigo, servidor } = novo();
    const t = await comFragmento(codigo, servidor);
    servidor.falhar(ATIVAR, 'segurar');
    const botao = t.botao(TEXTOS.ativacaoBotao);
    await botao.disparar('click');
    await botao.disparar('click');
    servidor.liberarSegurados();
    await t.passar(1000);
    assert.equal(servidor.contar(ATIVAR), 1);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
  });
});

describe('[G2-C] INICIO: estado do tablet e atendimento deixado aberto', () => {
  test('[G2-20] sem fragmento: consulta o estado e depois o atendimento, sem renovar; sem atendimento aberto não encerra nada', async () => {
    const servidor = H.criarServidor();
    await H.abrirTotem({ servidor });
    assert.deepEqual(servidor.chamadas.map((c) => c.chave), [ESTADO, ATENDIMENTO_GET]);
    assert.equal(servidor.atividades, 0);
  });

  test('[G2-21] atendimento aberto encontrado: é encerrado no servidor e nada dele aparece', async () => {
    const servidor = H.criarServidor();
    const a = await H.abrirIdentificado({ servidor });
    assert.equal(servidor.atendimentoAberto(), true);
    const b = await H.abrirTotem({ servidor });
    assert.deepEqual(servidor.chamadas.slice(-3).map((c) => c.chave), [ESTADO, ATENDIMENTO_GET, ENCERRAR]);
    assert.equal(servidor.atendimentoAberto(), false);
    assert.deepEqual(b.telaAtual(), ['telaAcesso']);
    assert.ok(!b.textoDoDom().includes('Ana'));
    assert.equal(b.storage.length, 0);
    assert.ok(a);
  });

  test('[G2-22] falha de comunicação ao abrir: identificação com o texto próprio, sem presumir autorização', async () => {
    const servidor = H.criarServidor();
    servidor.falhar(ESTADO, 'rede');
    const t = await H.abrirTotem({ servidor });
    assert.ok(t.textoVisivel().includes(TEXTOS.comunicacao));
    assert.ok(!t.textoVisivel().includes(H.SENTINELA));
  });

  test('[G2-23] pageshow restaurado do cache: volta ao início, encerra o atendimento aberto e limpa tudo', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor });
    await t.eventoDaJanela('pageshow', { persisted: true });
    await t.passar(1000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.equal(servidor.atendimentoAberto(), false);
    assert.ok(!t.textoDoDom().includes('Ana'));
    assert.equal(t.visivel('sessao'), false);
    assert.equal(t.el('doc').value, '');
  });

  test('[G2-24] navegação de retorno (popstate) não restaura nada e a página não cria entradas de histórico nem navegações', async () => {
    const t = await H.abrirIdentificado();
    await t.clicarTexto('Sair');
    await t.eventoDaJanela('popstate', { state: null });
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.equal(t.historico.filter((h) => h.metodo === 'pushState').length, 0);
    assert.equal(t.navegacoes.length, 0);
  });
});

describe('[G2-D] as duas credenciais: o tablet persiste, o atendimento do funcionário é temporário', () => {
  test('[G2-30] "Sair" encerra o atendimento e limpa o estado, e a credencial do tablet não é tocada', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor });
    await t.clicarTexto('Sair');
    assert.equal(servidor.contar(ENCERRAR), 1);
    assert.equal(servidor.atendimentos[0].encerrado, 'SAIDA');
    assert.equal(servidor.tablet, 'ativo');
    assert.equal(servidor.contar(ATIVAR), 0, 'nunca reativa nem desativa o tablet');
    assert.equal(t.cookiesEscritos.length, 0);
    assert.equal(t.storage.length, 0);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.equal(t.visivel('sessao'), false);
    assert.equal(t.texto('quem').trim(), '');
    await t.identificar({ tipo: 'MATRICULA', valor: BRUNO.matricula });
    assert.ok(t.textoVisivel().includes('Olá, Bruno'), 'o tablet continua autorizado para o próximo atendimento');
  });

  test('[G2-31] expiração em 60 s sem renovação: limpeza imediata, sem criar novo atendimento e sem mexer no tablet', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor });
    await t.passar(61000);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.ok(t.textoVisivel().includes(TEXTOS.expirada));
    assert.ok(!t.textoDoDom().includes('Ana'));
    assert.equal(servidor.atendimentos.length, 1, 'não cria atendimento sozinho');
    assert.equal(servidor.atividades, 0, 'nenhuma renovação neste incremento');
    assert.equal(servidor.tablet, 'ativo');
    assert.equal(t.visivel('sessao'), false);
  });

  test('[G2-32] falha ao encerrar: o estado sensível some na hora, a sessão antiga não é mais usada e não se presume o encerramento no servidor', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor });
    servidor.falhar(ENCERRAR, 'rede');
    await t.clicarTexto('Sair');
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.ok(!t.textoDoDom().includes('Ana'));
    assert.equal(servidor.contar(ENCERRAR), 1, 'sem repetição automática');
    await t.passar(30000, 5000);
    assert.equal(servidor.contar(ENCERRAR), 1);
    assert.equal(servidor.atendimentoAberto(), true, 'limitação: o servidor só encerra pelos 60 s');
    assert.equal(servidor.tablet, 'ativo');
  });

  test('[G2-33] sessão já invalidada pelo servidor ao sair (401): limpa do mesmo jeito, sem criar atendimento', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirIdentificado({ servidor });
    servidor.atendimentos[0].encerrado = 'SUBSTITUIDO';
    await t.clicarTexto('Sair');
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.equal(servidor.atendimentos.length, 1);
  });

  test('[G2-34] tablet revogado ao identificar (401 do dispositivo): tela de bloqueio, sem expor nada', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    servidor.tablet = 'nao_autorizado';
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    assert.deepEqual(t.telaAtual(), ['telaNaoAutorizado']);
    assert.ok(t.textoVisivel().includes(TEXTOS.naoAutorizado));
    assert.ok(!t.textoDoDom().includes(ANA.cpf));
  });

  test('[G2-35] rede não autorizada ao identificar (403): tela da rede', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    servidor.tablet = 'rede';
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    assert.deepEqual(t.telaAtual(), ['telaRede']);
    assert.ok(t.textoVisivel().includes(TEXTOS.foraDaRede));
  });
});

describe('[G2-E] identificação: guardas de envio e limites', () => {
  test('[G2-40] duplo toque em "Continuar" com a primeira requisição em andamento envia uma só identificação', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    await t.escolherTipo('CPF');
    await t.digitar(ANA.cpf);
    servidor.falhar(IDENT, 'segurar');
    const botao = t.botao('Continuar');
    await botao.disparar('click');
    await botao.disparar('click');
    servidor.liberarSegurados();
    await t.passar(1000);
    assert.equal(servidor.contar(IDENT), 1);
    assert.equal(servidor.atendimentos.length, 1);
  });

  test('[G2-41] 429 respeita o Retry-After: nenhum envio até o prazo, e depois dele a pessoa pode tentar de novo', async () => {
    const servidor = H.criarServidor();
    servidor.identificacoes = Array(10).fill(0);
    const t = await H.abrirTotem({ servidor });
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    assert.equal(servidor.contar(IDENT), 1);
    await t.clicarTexto('Continuar');
    assert.equal(servidor.contar(IDENT), 1, 'dentro do prazo não há novo envio');
    assert.ok(t.textoVisivel().includes(TEXTOS.limite));
    await t.passar(31000, 1000);
    await t.digitar(ANA.cpf);
    await t.clicarTexto('Continuar');
    assert.equal(servidor.contar(IDENT), 2);
  });

  test('[G2-42] identificação sem resultado (rede): texto neutro, nenhum atendimento presumido, nenhuma repetição automática e encerramento em melhor esforço', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    servidor.falhar(IDENT, 'rede');
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    assert.ok(t.textoVisivel().includes(TEXTOS.comunicacao));
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
    assert.equal(t.visivel('sessao'), false);
    await t.passar(30000, 5000);
    assert.equal(servidor.contar(IDENT), 1);
    assert.equal(servidor.contar(ENCERRAR), 1, 'fecha, se existir, um atendimento que pode ter sido criado sem resposta');
  });

  test('[G2-43] 201 fora do contrato não vira atendimento: nada de sessão, texto neutro', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    servidor.falhar(IDENT, 'status', { status: 201, corpo: { status: 'ok' } });
    await t.identificar({ tipo: 'CPF', valor: ANA.cpf });
    assert.ok(t.textoVisivel().includes(TEXTOS.comunicacao));
    assert.equal(t.visivel('sessao'), false);
    assert.deepEqual(t.telaAtual(), ['telaAcesso']);
  });

  test('[G2-44] nenhuma mensagem do servidor chega à tela e a identificação nunca vai a console, storage, histórico ou cookie', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    await t.identificar({ tipo: 'CPF', valor: '99999999999' });
    await t.clicarTexto('Limpar');
    await t.identificar({ tipo: 'MATRICULA', valor: ANA.matricula });
    assert.ok(!t.textoDoDom().includes(H.SENTINELA));
    assert.deepEqual(H.vazamentos(t, { cpf: ANA.cpf, matricula: ANA.matricula }).filter((x) => !x.endsWith('em dom')), []);
    assert.deepEqual(t.consoleChamadas, []);
  });

  test('[G2-45] sem escolher o tipo a página orienta pelo seletor (sem texto novo) e não envia nada', async () => {
    const servidor = H.criarServidor();
    const t = await H.abrirTotem({ servidor });
    await t.digitar('1234');
    await t.clicarTexto('Continuar');
    assert.equal(servidor.contar(IDENT), 0);
    assert.equal(t.el('tipoCpf').getAttribute('aria-pressed'), 'false');
    assert.equal(t.el('tipoMatricula').getAttribute('aria-pressed'), 'false');
  });
});

describe('[G2-F] o QR continua sem expor o código na Central e o Totem não depende dela', () => {
  test('[G2-50] o módulo da Central só mudou em ativacao.conteudoQr: o resto do contrato exportado segue igual', () => {
    const T = require('../js/atendimento-token');
    assert.deepEqual(Object.keys(T.ativacao).sort(), ['VALIDADE_MAXIMA_MS', 'conteudoQr', 'daGeracao', 'restanteMs']);
    assert.equal(T.ativacao.VALIDADE_MAXIMA_MS, 10 * 60 * 1000);
  });

  test('[G2-51] a origem inválida (sem http/https) não gera QR: o erro chega à Central, que mostra "QR indisponível"', () => {
    const T = require('../js/atendimento-token');
    const anterior = Object.getOwnPropertyDescriptor(globalThis, 'location');
    Object.defineProperty(globalThis, 'location', { value: { origin: 'null' }, configurable: true, writable: true });
    try { assert.throws(() => T.ativacao.conteudoQr(H.novoToken()), TypeError); } finally { if (anterior) Object.defineProperty(globalThis, 'location', anterior); else delete globalThis.location; }
  });

  test('[G2-52] a página do Totem está na allowlist e o fragmento usa o mesmo nome que o boot.js lê (#ativar=)', () => {
    const { boot } = H.corpus();
    assert.match(boot, /#ativar=/);
    const lista = JSON.parse(fs.readFileSync(path.join(RAIZ, 'publicacao', 'allowlist.json'), 'utf8')).arquivos;
    assert.ok(lista.includes('totem/index.html'));
  });
});
