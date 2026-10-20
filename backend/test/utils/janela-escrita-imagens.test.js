'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const a = require('../helpers/limpeza-orfaos');

/**
 * Trava de JANELA DE ESCRITA do armazenamento de imagens (Biblioteca de Imagens, P-ORF-01, fase RED). Exclusão mútua entre a LIMPEZA DE ÓRFÃOS e qualquer outra
 * operação que precise do diretório sem escritores, em especial o BACKUP (janela (A) do Documento 65, seção 7.2: "a limpeza e o backup devem se excluir mutuamente").
 *
 * Módulo previsto: src/utils/janela-escrita-imagens.js
 *
 *   TIPOS                              { BACKUP: 'BACKUP', LIMPEZA: 'LIMPEZA' }  (congelado)
 *   VARIAVEL_ARQUIVO                   'IMAGENS_JANELA_ESCRITA_ARQUIVO'
 *   lerArquivoDaJanela(origem)         caminho da trava a partir do ambiente (absoluto e canônico) ou null; valor inválido: erro IMAGENS_CONFIGURACAO_INVALIDA que
 *                                      nomeia a variável e nunca ecoa o valor
 *   adquirirJanela({ arquivo, tipo, raizArmazenamento, agora?, pid?, hospedeiro? }) -> Promise<{ tipo, liberar(): Promise<{ liberada: boolean }> }>
 *   lerJanela({ arquivo })             -> Promise<null | { versao, tipo, pid, hospedeiro, iniciadoEm }>   (NUNCA devolve o token; documento ilegível: JANELA_DOCUMENTO_INVALIDO)
 *   validarArquivoDaJanela({ arquivo, raizArmazenamento }) -> Promise<void>   (mesmas regras de caminho de adquirirJanela, sem criar nada; a simulação da limpeza a usa)
 *   ErroDeJanela                       Error com `codigo` (JANELA_OCUPADA [com `dono`], JANELA_ARQUIVO_INVALIDO, JANELA_DENTRO_DO_ARMAZENAMENTO, JANELA_TIPO_INVALIDO,
 *                                      JANELA_DOCUMENTO_INVALIDO)
 *
 * PROTOCOLO (o procedimento de backup o cumpre à mão, em shell): um arquivo comum, criado de forma EXCLUSIVA (O_CREAT | O_EXCL | O_NOFOLLOW), modo 0600, com um
 * documento JSON { versao: 1, tipo, pid, hospedeiro, iniciadoEm (ISO), token (hex) }. Quem encontra o arquivo NUNCA o apaga nem o sobrescreve, nem mesmo de dono morto
 * (falha fechada: quem decide é uma pessoa). Só o dono, com o mesmo token, o remove. O caminho é absoluto, canônico, de pasta existente (nunca criada) e FORA da
 * árvore do armazenamento (dentro dela a trava apareceria como entrada inesperada para o verificador).
 *
 * PRECISÕES do contrato (apontadas na revisão independente da fase RED):
 *   - TODAS as operações do módulo são assíncronas (devolvem Promise), inclusive `liberar`; `new ErroDeJanela(codigo, dono = null)`.
 *   - "Canônico" é LÉXICO para o caminho recebido (`path.resolve(x) === x`: sem "..", sem "//", sem "/" final). A contenção, porém, é julgada DEPOIS de resolver a pasta onde a
 *     trava ficaria (realpath da pasta): um caminho que, por um link simbólico, cai dentro do armazenamento é JANELA_DENTRO_DO_ARMAZENAMENTO.
 *   - A raiz do armazenamento pode NÃO EXISTIR (a limpeza toma a trava antes de ler qualquer coisa e só depois descobre que a raiz sumiu): nesse caso a contenção é
 *     julgada de forma léxica sobre `path.resolve(raizArmazenamento)`, sem erro e sem criar nada (JAN-24).
 */

const { AGORA } = a;
const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };

const J = () => exigirModulo('src/utils/janela-escrita-imagens');

/** Armazenamento (raiz) e pasta da trava são diretórios temporários DISTINTOS. */
function cenario() {
  const raiz = novaRaiz();
  const pastaDaTrava = novaRaiz();
  return { raiz, pastaDaTrava, arquivo: path.join(pastaDaTrava, 'janela-imagens.lock') };
}
const adquirir = (c, extra = {}) => J().adquirirJanela({ arquivo: c.arquivo, tipo: 'LIMPEZA', raizArmazenamento: c.raiz, agora: () => AGORA, ...extra });
const lerDoc = (arquivo) => JSON.parse(fs.readFileSync(arquivo, 'utf8'));

describe('[JAN] interface e criação exclusiva', () => {
  test('JAN-01 — a interface prevista existe, os tipos são exatamente BACKUP e LIMPEZA (congelados) e a variável de ambiente tem o nome combinado', () => {
    const m = J();
    for (const nome of ['adquirirJanela', 'lerJanela', 'lerArquivoDaJanela', 'validarArquivoDaJanela']) assert.equal(typeof m[nome], 'function', nome);
    assert.deepEqual(m.TIPOS, { BACKUP: 'BACKUP', LIMPEZA: 'LIMPEZA' });
    assert.equal(Object.isFrozen(m.TIPOS), true);
    assert.equal(m.VARIAVEL_ARQUIVO, 'IMAGENS_JANELA_ESCRITA_ARQUIVO');
    assert.equal(typeof m.ErroDeJanela, 'function');
    assert.equal(new m.ErroDeJanela('JANELA_OCUPADA', null) instanceof Error, true);
  });

  test('JAN-02 — adquirir cria UM arquivo, de forma exclusiva, modo 600, com o documento do protocolo (versao, tipo, pid, hospedeiro, iniciadoEm, token)', async () => {
    const c = cenario();
    const janela = await adquirir(c, { pid: 4321, hospedeiro: 'maquina-de-teste' });
    assert.equal(janela.tipo, 'LIMPEZA');
    assert.equal(typeof janela.liberar, 'function');
    assert.deepEqual(fs.readdirSync(c.pastaDaTrava), ['janela-imagens.lock'], 'nenhum temporário nem outro arquivo');
    assert.equal((fs.statSync(c.arquivo).mode & 0o777).toString(8), '600');
    const documento = lerDoc(c.arquivo);
    assert.deepEqual(Object.keys(documento).sort(), ['hospedeiro', 'iniciadoEm', 'pid', 'tipo', 'token', 'versao']);
    assert.deepEqual({ versao: documento.versao, tipo: documento.tipo, pid: documento.pid, hospedeiro: documento.hospedeiro, iniciadoEm: documento.iniciadoEm },
      { versao: 1, tipo: 'LIMPEZA', pid: 4321, hospedeiro: 'maquina-de-teste', iniciadoEm: new Date(AGORA).toISOString() });
    assert.match(documento.token, /^[0-9a-f]{32,}$/);
    await janela.liberar();
  });

  test('JAN-03 — por padrão o dono é o próprio processo (pid) e o hospedeiro é um texto não vazio', async () => {
    const c = cenario();
    const janela = await adquirir(c);
    const documento = lerDoc(c.arquivo);
    assert.equal(documento.pid, process.pid);
    assert.equal(typeof documento.hospedeiro, 'string');
    assert.ok(documento.hospedeiro.length > 0 && documento.hospedeiro.length <= 255);
    await janela.liberar();
  });
});

describe('[JAN] exclusão mútua: quem chega depois é recusado, sem tocar na trava do dono', () => {
  test('JAN-04 — segunda aquisição é recusada em TODAS as combinações de tipo, descreve o dono e deixa o arquivo byte a byte intacto', async () => {
    for (const [primeiro, segundo] of [['BACKUP', 'LIMPEZA'], ['LIMPEZA', 'BACKUP'], ['BACKUP', 'BACKUP'], ['LIMPEZA', 'LIMPEZA']]) {
      const c = cenario();
      const dono = await adquirir(c, { tipo: primeiro, pid: 777 });
      const antes = fs.readFileSync(c.arquivo);
      const erro = await adquirir(c, { tipo: segundo }).then(() => null, (e) => e);
      assert.ok(erro instanceof J().ErroDeJanela, `${primeiro} → ${segundo}: deveria ser ErroDeJanela`);
      assert.equal(erro.codigo, 'JANELA_OCUPADA');
      assert.deepEqual(erro.dono, { versao: 1, tipo: primeiro, pid: 777, hospedeiro: lerDoc(c.arquivo).hospedeiro, iniciadoEm: new Date(AGORA).toISOString() });
      assert.deepEqual(fs.readFileSync(c.arquivo), antes, 'a trava do dono não pode mudar');
      assert.deepEqual((await dono.liberar()), { liberada: true }, 'o dono original continua podendo liberar');
    }
  });

  test('JAN-05 — 25 aquisições simultâneas: exatamente UMA vence, as outras 24 recebem JANELA_OCUPADA e o arquivo é do vencedor', async () => {
    const c = cenario();
    const resultados = await Promise.allSettled(Array.from({ length: 25 }, (_, i) => adquirir(c, { tipo: i % 2 === 0 ? 'LIMPEZA' : 'BACKUP', pid: 1000 + i })));
    const vencedoras = resultados.filter((r) => r.status === 'fulfilled');
    const recusadas = resultados.filter((r) => r.status === 'rejected');
    assert.equal(vencedoras.length, 1);
    assert.equal(recusadas.length, 24);
    for (const r of recusadas) assert.equal(r.reason.codigo, 'JANELA_OCUPADA');
    const documento = lerDoc(c.arquivo);
    assert.equal(documento.tipo, vencedoras[0].value.tipo);
    assert.deepEqual(await vencedoras[0].value.liberar(), { liberada: true });
    assert.deepEqual(fs.readdirSync(c.pastaDaTrava), []);
  });

  test('JAN-06 — trava de um processo que JÁ MORREU, ou muito antiga, NÃO é quebrada sozinha (falha fechada): continua JANELA_OCUPADA e o arquivo fica como estava', async () => {
    const c = cenario();
    const velha = new Date(AGORA - 400 * 24 * 60 * 60 * 1000).toISOString();
    const documento = a.escreverTravaAlheia(c.arquivo, { tipo: 'LIMPEZA', pid: a.pidMorto(), iniciadoEm: velha });
    const antes = fs.readFileSync(c.arquivo);
    const erro = await adquirir(c, { tipo: 'BACKUP' }).then(() => null, (e) => e);
    assert.equal(erro?.codigo, 'JANELA_OCUPADA');
    assert.equal(erro.dono.pid, documento.pid);
    assert.equal(erro.dono.iniciadoEm, velha);
    assert.deepEqual(fs.readFileSync(c.arquivo), antes);
  });

  test('JAN-07 — arquivo existente ilegível ou fora do protocolo (lixo, JSON de outro formato) também ocupa a janela: JANELA_OCUPADA com dono null, intacto; lerJanela o recusa', async () => {
    for (const conteudo of ['lixo qualquer', '{"outra":"coisa"}', '']) {
      const c = cenario();
      fs.writeFileSync(c.arquivo, conteudo, { mode: 0o600 });
      const erro = await adquirir(c).then(() => null, (e) => e);
      assert.equal(erro?.codigo, 'JANELA_OCUPADA', JSON.stringify(conteudo));
      assert.equal(erro.dono, null);
      assert.equal(fs.readFileSync(c.arquivo, 'utf8'), conteudo);
      await assert.rejects(J().lerJanela({ arquivo: c.arquivo }), (e) => e.codigo === 'JANELA_DOCUMENTO_INVALIDO');
    }
  });

  test('JAN-08 — a mensagem do erro de janela ocupada nunca leva caminho, token nem PID', async () => {
    const c = cenario();
    const documento = a.escreverTravaAlheia(c.arquivo, { tipo: 'BACKUP', pid: 987654 });
    const erro = await adquirir(c).then(() => null, (e) => e);
    assert.equal(erro?.codigo, 'JANELA_OCUPADA');
    for (const proibido of [c.arquivo, c.pastaDaTrava, documento.token, '987654', c.raiz]) assert.equal(erro.message.includes(proibido), false, proibido);
  });
});

describe('[JAN] liberar', () => {
  test('JAN-09 — liberar remove SÓ o arquivo da trava, é idempotente e libera a vaga para uma nova aquisição', async () => {
    const c = cenario();
    const outro = path.join(c.pastaDaTrava, 'outro-arquivo.txt');
    fs.writeFileSync(outro, 'não é meu');
    const janela = await adquirir(c);
    assert.deepEqual(await janela.liberar(), { liberada: true });
    assert.equal(fs.existsSync(c.arquivo), false);
    assert.equal(fs.readFileSync(outro, 'utf8'), 'não é meu', 'o resto da pasta não é tocado');
    assert.deepEqual(await janela.liberar(), { liberada: false }, 'segunda liberação: nada a fazer');
    const nova = await adquirir(c, { tipo: 'BACKUP' });
    assert.equal(nova.tipo, 'BACKUP');
    await nova.liberar();
  });

  test('JAN-10 — liberar NÃO remove a trava de OUTRO dono (token diferente): se alguém apagou e recriou o arquivo, o dono antigo não leva a trava nova', async () => {
    const c = cenario();
    const antigo = await adquirir(c, { tipo: 'LIMPEZA' });
    fs.unlinkSync(c.arquivo);
    const doDono = a.escreverTravaAlheia(c.arquivo, { tipo: 'BACKUP' });
    assert.deepEqual(await antigo.liberar(), { liberada: false });
    assert.equal(fs.existsSync(c.arquivo), true);
    assert.equal(lerDoc(c.arquivo).token, doDono.token);
  });

  test('JAN-11 — liberar também funciona quando o arquivo já sumiu (nada a remover, sem erro)', async () => {
    const c = cenario();
    const janela = await adquirir(c);
    fs.unlinkSync(c.arquivo);
    assert.deepEqual(await janela.liberar(), { liberada: false });
  });
});

describe('[JAN] onde a trava pode ficar', () => {
  test('JAN-12 — arquivo DENTRO do armazenamento é recusado (JANELA_DENTRO_DO_ARMAZENAMENTO) e nada é criado; vale também por um link simbólico para dentro', async () => {
    const c = cenario();
    const antes = a.h.retratoDaArvore(c.raiz);
    const dentro = await adquirir(c, { arquivo: path.join(c.raiz, 'janela.lock') }).then(() => null, (e) => e);
    assert.equal(dentro?.codigo, 'JANELA_DENTRO_DO_ARMAZENAMENTO');
    const subpasta = path.join(c.raiz, '7');
    fs.mkdirSync(subpasta);
    const ponte = path.join(c.pastaDaTrava, 'ponte');
    fs.symlinkSync(subpasta, ponte);
    const viaLink = await adquirir(c, { arquivo: path.join(ponte, 'janela.lock') }).then(() => null, (e) => e);
    assert.equal(viaLink?.codigo, 'JANELA_DENTRO_DO_ARMAZENAMENTO');
    assert.deepEqual(fs.readdirSync(subpasta), []);
    assert.deepEqual(a.h.retratoDaArvore(c.raiz).filter((i) => i.rel !== '7'), antes);
  });

  test('JAN-13 — caminhos inválidos (relativo, vazio, não texto, com NUL, com "..", raiz do sistema, terminado em "/") são JANELA_ARQUIVO_INVALIDO e nada é criado', async () => {
    const c = cenario();
    const invalidos = ['janela.lock', '', null, 42, `${c.pastaDaTrava}/x\0.lock`, `${c.pastaDaTrava}/sub/../fora.lock`, '/', `${c.pastaDaTrava}/`];
    for (const arquivo of invalidos) {
      const erro = await adquirir(c, { arquivo }).then(() => null, (e) => e);
      assert.equal(erro?.codigo, 'JANELA_ARQUIVO_INVALIDO', String(arquivo));
    }
    assert.deepEqual(fs.readdirSync(c.pastaDaTrava), [], 'nenhum arquivo nem pasta foi criado (o "sub/../fora.lock" cairia aqui se fosse aceito)');
  });

  test('JAN-14 — pasta pai inexistente é recusada e a pasta NÃO é criada; a raiz do armazenamento é obrigatória (TypeError)', async () => {
    const c = cenario();
    const pastaInexistente = path.join(c.pastaDaTrava, 'nao-existe');
    const erro = await adquirir(c, { arquivo: path.join(pastaInexistente, 'janela.lock') }).then(() => null, (e) => e);
    assert.equal(erro?.codigo, 'JANELA_ARQUIVO_INVALIDO');
    assert.equal(fs.existsSync(pastaInexistente), false, 'a pasta não pode ser criada');
    await assert.rejects(J().adquirirJanela({ arquivo: c.arquivo, tipo: 'LIMPEZA' }), TypeError);
    assert.equal(fs.existsSync(c.arquivo), false);
  });

  test('JAN-15 — um link simbólico no lugar do arquivo nunca é seguido: o alvo (existente ou não) não é criado nem alterado', async () => {
    const c = cenario();
    const alvo = path.join(c.pastaDaTrava, 'alvo-alheio.txt');
    fs.writeFileSync(alvo, 'conteudo-alheio');
    fs.symlinkSync(alvo, c.arquivo);
    const e1 = await adquirir(c).then(() => null, (e) => e);
    assert.ok(e1 instanceof J().ErroDeJanela);
    assert.equal(fs.readFileSync(alvo, 'utf8'), 'conteudo-alheio');
    assert.equal(fs.lstatSync(c.arquivo).isSymbolicLink(), true);
    fs.unlinkSync(c.arquivo);
    const pendurado = path.join(c.pastaDaTrava, 'alvo-que-nao-existe.txt');
    fs.symlinkSync(pendurado, c.arquivo);
    const e2 = await adquirir(c).then(() => null, (e) => e);
    assert.ok(e2 instanceof J().ErroDeJanela);
    assert.equal(fs.existsSync(pendurado), false, 'o link para o vazio não pode fazer o arquivo ser criado do outro lado');
  });

  test('JAN-16 — tipo inválido (outro texto, minúsculas, ausente) é JANELA_TIPO_INVALIDO e nada é criado', async () => {
    const c = cenario();
    for (const tipo of ['OUTRO', 'backup', 'Limpeza', undefined, null, 1]) {
      const erro = await adquirir(c, { tipo }).then(() => null, (e) => e);
      assert.equal(erro?.codigo, 'JANELA_TIPO_INVALIDO', String(tipo));
    }
    assert.deepEqual(fs.readdirSync(c.pastaDaTrava), []);
  });
});

describe('[JAN] leitura e configuração', () => {
  test('JAN-17 — lerJanela: null quando não há trava; descreve o dono (sem o token) quando há, inclusive a criada à mão pelo procedimento de backup', async () => {
    const c = cenario();
    assert.equal(await J().lerJanela({ arquivo: c.arquivo }), null);
    const doc = a.escreverTravaAlheia(c.arquivo, { tipo: 'BACKUP', pid: 555, hospedeiro: 'servidor-de-backup' });
    const lida = await J().lerJanela({ arquivo: c.arquivo });
    assert.deepEqual(lida, { versao: 1, tipo: 'BACKUP', pid: 555, hospedeiro: 'servidor-de-backup', iniciadoEm: doc.iniciadoEm });
    assert.equal(Object.hasOwn(lida, 'token'), false, 'o token é a prova de posse: nunca sai pela leitura');
  });

  test('JAN-18 — lerArquivoDaJanela: ausente, vazio ou só espaços é null; valor válido é devolvido; relativo, com NUL, não canônico, raiz ou terminado em "/" é erro de configuração sem ecoar o valor', () => {
    const { lerArquivoDaJanela, VARIAVEL_ARQUIVO } = J();
    for (const origem of [{}, { [VARIAVEL_ARQUIVO]: '' }, { [VARIAVEL_ARQUIVO]: '   ' }, { [VARIAVEL_ARQUIVO]: undefined }]) assert.equal(lerArquivoDaJanela(origem), null);
    assert.equal(lerArquivoDaJanela({ [VARIAVEL_ARQUIVO]: '/var/lib/safework/janela-imagens.lock' }), '/var/lib/safework/janela-imagens.lock');
    for (const ruim of ['janela.lock', './janela.lock', '/a/../b/janela.lock', '/a//b/janela.lock', '/', '/var/lib/safework/', '/x/\0y']) {
      let erro = null;
      try { lerArquivoDaJanela({ [VARIAVEL_ARQUIVO]: ruim }); } catch (e) { erro = e; }
      assert.equal(erro?.codigo, 'IMAGENS_CONFIGURACAO_INVALIDA', ruim);
      assert.ok(erro.message.includes(VARIAVEL_ARQUIVO));
      const valor = ruim.replace('\0', '');
      if (valor.length >= 5) assert.equal(erro.message.includes(valor), false, 'o valor recebido não pode aparecer na mensagem');
    }
  });

  test('JAN-19 — validarArquivoDaJanela aplica as MESMAS regras de caminho sem criar nada: aceita o válido; recusa dentro do armazenamento, relativo, pasta inexistente e documento do caminho inválido', async () => {
    const c = cenario();
    const { validarArquivoDaJanela } = J();
    await validarArquivoDaJanela({ arquivo: c.arquivo, raizArmazenamento: c.raiz });
    assert.equal(fs.existsSync(c.arquivo), false, 'validar nunca cria a trava');
    const codigo = async (arquivo) => validarArquivoDaJanela({ arquivo, raizArmazenamento: c.raiz }).then(() => null, (e) => e.codigo);
    assert.equal(await codigo(path.join(c.raiz, 'janela.lock')), 'JANELA_DENTRO_DO_ARMAZENAMENTO');
    assert.equal(await codigo('janela.lock'), 'JANELA_ARQUIVO_INVALIDO');
    assert.equal(await codigo(path.join(c.pastaDaTrava, 'nao-existe', 'janela.lock')), 'JANELA_ARQUIVO_INVALIDO');
    assert.equal(fs.existsSync(path.join(c.pastaDaTrava, 'nao-existe')), false);
    await assert.rejects(async () => validarArquivoDaJanela({ arquivo: c.arquivo }), TypeError);
    a.escreverTravaAlheia(c.arquivo, { tipo: 'BACKUP' });
    await validarArquivoDaJanela({ arquivo: c.arquivo, raizArmazenamento: c.raiz });
  });

  test('JAN-20 — lerArquivoDaJanela é função pura da origem recebida: não lê nem altera process.env', () => {
    const { lerArquivoDaJanela, VARIAVEL_ARQUIVO } = J();
    const antes = process.env[VARIAVEL_ARQUIVO];
    process.env[VARIAVEL_ARQUIVO] = '/nao/deveria/ser/lido.lock';
    try {
      assert.equal(lerArquivoDaJanela({}), null);
    } finally {
      if (antes === undefined) delete process.env[VARIAVEL_ARQUIVO]; else process.env[VARIAVEL_ARQUIVO] = antes;
    }
  });

  test('JAN-24 — a raiz do armazenamento pode NÃO EXISTIR (a limpeza toma a trava antes de ler qualquer coisa): a contenção é léxica, sem erro e sem criar a raiz; um arquivo que cairia dentro dessa raiz inexistente continua recusado', async () => {
    const c = cenario();
    const { adquirirJanela, validarArquivoDaJanela, ErroDeJanela } = J();
    const raizAusente = path.join(novaRaiz(), 'imagens-que-nao-existem');
    await validarArquivoDaJanela({ arquivo: c.arquivo, raizArmazenamento: raizAusente });
    const janela = await adquirirJanela({ arquivo: c.arquivo, tipo: 'LIMPEZA', raizArmazenamento: raizAusente, agora: () => AGORA });
    assert.equal(janela.tipo, 'LIMPEZA');
    assert.equal(fs.existsSync(raizAusente), false, 'a raiz não é criada');
    await janela.liberar();
    const dentro = await adquirirJanela({ arquivo: path.join(raizAusente, 'janela.lock'), tipo: 'LIMPEZA', raizArmazenamento: raizAusente }).then(() => null, (e) => e);
    assert.ok(dentro instanceof ErroDeJanela);
    assert.ok(['JANELA_DENTRO_DO_ARMAZENAMENTO', 'JANELA_ARQUIVO_INVALIDO'].includes(dentro.codigo), dentro.codigo);
    assert.equal(fs.existsSync(raizAusente), false, 'nada foi criado dentro nem fora');
  });
});
