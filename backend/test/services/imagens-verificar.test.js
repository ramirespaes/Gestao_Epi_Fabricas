'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const h = require('../helpers/verificacao-imagens');

/**
 * Verificador de integridade das imagens armazenadas (Biblioteca de Imagens, Unidade 5C-5): SOMENTE LEITURA.
 *
 * Módulo previsto: src/services/imagem-armazenamento-verificacao.service.js, com `verificarArmazenamento(pool, opcoes)` e `identificarBanco(pool)`,
 * apoiado em src/repositories/imagem-verificacao.repository.js (consultas SELECT em transação READ ONLY).
 *
 * O verificador cruza os REGISTROS (imagens_padrao e imagens_empresa) com os ARQUIVOS do armazenamento e classifica cada imagem e cada sobra:
 *   INTEGRO      — registro e arquivos conferem (existência, tipo, tamanho, SHA-256 e assinatura do formato).
 *   RECUPERAVEL  — o registro está íntegro e o arquivo ESPERADO não existe: dá para restaurá-lo do backup e conferir o SHA-256 do próprio registro.
 *   INVESTIGAR   — há divergência de conteúdo, tipo de entrada impróprio (link simbólico etc.), registro inconsistente ou leitura que falhou (nunca contado como
 *                  íntegro, nunca como ausente); ou estrutura estranha. Ninguém corrige sozinho.
 *   ORFAO        — arquivo sem registro (sobra por desenho: exclusão não apaga arquivo; falha entre gravações; resíduo .tmp). Não é dano; limpeza é decisão futura.
 * O veredito do relatório é a PIOR classe presente (INTEGRO < ORFAO < RECUPERAVEL < INVESTIGAR). Órfão mais novo que a idade mínima pode ser um envio em
 * andamento (os arquivos são gravados ANTES do INSERT): fica em `recente`, fora dos contadores e do veredito.
 *
 * SEGURANÇA DOS TESTES: só escrevem em diretórios temporários EXCLUSIVOS (tmp-seguro.js) e usam um banco FALSO em memória. Nada de pasta real de imagens.
 */

const M = () => exigirModulo('src/services/imagem-armazenamento-verificacao.service');
const AGORA = Date.parse('2026-10-18T12:00:00.000Z');
const MIN = h.MINUTO;
const DIA = h.DIA_EM_MINUTOS;
const POSIX = process.platform !== 'win32';
const SO_POSIX = { skip: !POSIX && 'depende de links simbólicos POSIX' };

const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
function novaRaiz() {
  const raiz = criarRaizTemporaria();
  raizes.push(raiz);
  return raiz;
}

const verificar = (raiz, pool, extra = {}) => M().verificarArmazenamento(pool, { diretorio: raiz, agora: () => AGORA, ...extra });
const doAchado = (relatorio, imagemId, escopo = null) => relatorio.imagens.find((i) => i.imagemId === String(imagemId) && (escopo === null || i.escopo === escopo));
const tipos = (imagem) => imagem.achados.map((a) => `${a.variante}:${a.tipo}`);
const doArmazenamento = (relatorio, tipo) => relatorio.armazenamento.filter((a) => a.tipo === tipo);
const PROIBIDOS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/;

/** Cenário básico íntegro: 2 padrões, 3 imagens de duas empresas. */
function cenarioIntegro(raiz) {
  const p1 = h.criarImagemPadrao(raiz, { id: 1, formato: 'PNG', agora: AGORA });
  const p2 = h.criarImagemPadrao(raiz, { id: 2, formato: 'JPEG', comExibicao: true, agora: AGORA });
  const e10 = h.criarImagemEmpresa(raiz, { id: 10, empresaId: 7, formato: 'PNG', agora: AGORA });
  const e11 = h.criarImagemEmpresa(raiz, { id: 11, empresaId: 7, formato: 'WEBP', agora: AGORA });
  const e12 = h.criarImagemEmpresa(raiz, { id: 12, empresaId: 9, formato: 'JPEG', agora: AGORA });
  const pool = (extra = {}) => h.poolFalso({ padrao: [p1.linha, p2.linha], empresa: [e10.linha, e11.linha, e12.linha], ...extra });
  return { p1, p2, e10, e11, e12, pool };
}

/** Um registro íntegro qualquer: com o banco vazio, sobras no armazenamento disparariam o alerta de "banco sem registros", que mudaria o veredito dos testes de órfãos. */
function comRegistroBase(raiz, extra = {}) {
  const base = h.criarImagemPadrao(raiz, { id: 900, agora: AGORA });
  return { padrao: [base.linha], ...extra };
}

describe('[VER] contrato do módulo e SOMENTE LEITURA por construção', () => {
  test('VER-01 — a interface existe e as classes e tipos são congelados', () => {
    const modulo = M();
    assert.equal(typeof modulo.verificarArmazenamento, 'function');
    assert.equal(typeof modulo.identificarBanco, 'function');
    assert.deepEqual(modulo.CLASSES, { INTEGRO: 'INTEGRO', ORFAO: 'ORFAO', RECUPERAVEL: 'RECUPERAVEL', INVESTIGAR: 'INVESTIGAR' });
    assert.equal(Object.isFrozen(modulo.CLASSES), true);
    assert.equal(Object.isFrozen(modulo.TIPOS), true);
    for (const tipo of ['ARQUIVO_AUSENTE', 'TAMANHO_DIVERGENTE', 'SHA256_DIVERGENTE', 'ASSINATURA_DIVERGENTE', 'FORMATO_DIVERGENTE', 'ENTRADA_INVALIDA', 'LEITURA_FALHOU', 'REGISTRO_INVALIDO',
      'ORFAO_CONJUNTO', 'ORFAO_VARIANTE', 'TEMPORARIO_RESIDUAL', 'ENTRADA_INESPERADA', 'ORFAO_EMPRESA_INEXISTENTE']) {
      assert.equal(modulo.TIPOS[tipo], tipo, tipo);
    }
  });

  test('VER-02 — guarda de fonte: nenhum arquivo da unidade tem API de escrita no disco nem SQL que escreva', () => {
    const raizBackend = path.join(__dirname, '..', '..');
    const arquivos = ['src/services/imagem-armazenamento-verificacao.service.js', 'src/repositories/imagem-verificacao.repository.js', 'scripts/imagens-verificar.js'];
    const semComentarios = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:'"`])\/\/.*$/gm, '$1');
    const ESCRITA_DE_DISCO = /\b(?:writeFile|appendFile|createWriteStream|mkdir|rmdir|rm|unlink|rename|copyFile|cp|truncate|ftruncate|chmod|chown|utimes|futimes|link|symlink|mkdtemp|writeSync|write)\s*\(/;
    const ESCRITA_DE_BANCO = /\b(?:INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|GRANT|REVOKE|VACUUM|COPY|LOCK|COMMIT)\b/;
    for (const relativo of arquivos) {
      const texto = semComentarios(fs.readFileSync(path.join(raizBackend, relativo), 'utf8'));
      assert.doesNotMatch(texto, ESCRITA_DE_DISCO, `${relativo}: API de escrita no disco`);
      assert.doesNotMatch(texto, ESCRITA_DE_BANCO, `${relativo}: SQL que escreve`);
      assert.doesNotMatch(texto, /\bchild_process\b|\bexec(?:Sync)?\s*\(|\bspawn(?:Sync)?\s*\(/, `${relativo}: nenhum processo externo`);
    }
  });

  test('VER-03 — só operações de LEITURA no disco: lstat, readdir, realpath e open somente leitura sem seguir link', async () => {
    const raiz = novaRaiz();
    const { pool } = cenarioIntegro(raiz);
    h.gravarNaRaiz(raiz, `7/${'a'.repeat(64)}/mestre.png`, h.conteudoDe('PNG', 'orfao'), { agora: AGORA });
    const { fs: fachada, chamadas, abertos } = h.fachadaDeLeitura(raiz);
    await verificar(raiz, pool(), { fs: fachada });
    const usados = new Set(chamadas.map((c) => c.metodo));
    for (const metodo of usados) assert.ok(['lstat', 'readdir', 'realpath', 'open', 'stat', 'read', 'close'].includes(metodo), `operação não prevista: ${metodo}`);
    const FLAGS = fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW;
    const aberturas = chamadas.filter((c) => c.metodo === 'open');
    assert.ok(aberturas.length > 0, 'o conteúdo foi aberto para conferir o SHA-256');
    for (const abertura of aberturas) assert.equal(abertura.flags, FLAGS, `abertura fora de O_RDONLY | O_NOFOLLOW: ${abertura.rel}`);
    assert.equal(abertos.size, 0, 'nenhum descritor ficou aberto');
  });

  test('VER-04 — a árvore (arquivos, pastas, modos, mtimes, links, conteúdo) fica IDÊNTICA depois de verificar um cenário com todos os tipos de achado', SO_POSIX, async () => {
    const raiz = novaRaiz();
    const alvo = novaRaiz();
    const { p1, e10, e11 } = cenarioIntegro(raiz);
    const corrompido = h.criarImagemEmpresa(raiz, { id: 20, empresaId: 7, agora: AGORA });
    fs.appendFileSync(corrompido.caminho('exibicao'), 'x');
    const ausente = h.criarImagemEmpresa(raiz, { id: 21, empresaId: 7, agora: AGORA, ausentes: ['mestre'] });
    h.gravarNaRaiz(raiz, `7/${'b'.repeat(64)}/mestre.png`, h.conteudoDe('PNG', 'orfao'), { agora: AGORA });
    h.gravarNaRaiz(raiz, `7/${e10.shaEnvio}/mestre.png.0123456789abcdef.tmp`, Buffer.from('parcial'), { agora: AGORA });
    h.gravarNaRaiz(raiz, 'README.txt', Buffer.from('estranho'), { agora: AGORA });
    fs.writeFileSync(path.join(alvo, 'fora.bin'), h.conteudoDe('WEBP', 'fora'));
    fs.symlinkSync(path.join(alvo, 'fora.bin'), path.join(raiz, `7/${e11.shaEnvio}/solto`));
    fs.rmSync(p1.caminho('miniatura'));
    const antes = h.retratoDaArvore(raiz);
    const retratoAlvo = h.retratoDaArvore(alvo);
    const relatorio = await verificar(raiz, h.poolFalso({ padrao: [p1.linha], empresa: [e10.linha, e11.linha, corrompido.linha, ausente.linha] }));
    assert.equal(relatorio.veredito, 'INVESTIGAR');
    assert.deepEqual(h.retratoDaArvore(raiz), antes, 'a verificação não pode mudar nada na árvore');
    assert.deepEqual(h.retratoDaArvore(alvo), retratoAlvo, 'nem fora dela');
  });

  test('VER-05 — no banco, só BEGIN READ ONLY, SELECT e ROLLBACK; a conexão é sempre liberada', async () => {
    const raiz = novaRaiz();
    const { pool } = cenarioIntegro(raiz);
    const banco = pool();
    await verificar(raiz, banco);
    assert.deepEqual(banco.eventos, ['connect', 'release']);
    assert.match(banco.sql[0], /^BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY$/);
    assert.equal(banco.sql.at(-1), 'ROLLBACK');
    for (const comando of banco.sql.slice(1, -1)) assert.match(comando, /^SELECT\b/, comando);
    for (const comando of banco.sql) assert.doesNotMatch(comando, /\b(INSERT|UPDATE|DELETE|TRUNCATE|DROP|ALTER|CREATE|COMMIT)\b/i, comando);
  });
});

describe('[VER] imagens íntegras', () => {
  test('VER-06 — registro e arquivos conferem (PNG, JPEG e WEBP; padrão com e sem exibição; duas empresas): veredito INTEGRO, nada a listar', async () => {
    const raiz = novaRaiz();
    const { pool } = cenarioIntegro(raiz);
    const r = await verificar(raiz, pool());
    assert.equal(r.versao, 1);
    assert.equal(r.geradoEm, new Date(AGORA).toISOString());
    assert.equal(r.veredito, 'INTEGRO');
    assert.deepEqual(r.resumo.registros, { padrao: 2, empresa: 3, total: 5 });
    assert.deepEqual(r.resumo.arquivos, { esperados: 14, integros: 14, ausentes: 0, divergentes: 0, naoVerificados: 0 });
    assert.deepEqual(r.resumo.imagens, { INTEGRO: 5, RECUPERAVEL: 0, INVESTIGAR: 0 });
    assert.deepEqual(r.imagens, []);
    assert.deepEqual(r.armazenamento, []);
    assert.deepEqual(r.alertas, []);
  });

  test('VER-07 — banco e armazenamento vazios: INTEGRO, sem alertas', async () => {
    const raiz = novaRaiz();
    const r = await verificar(raiz, h.poolFalso());
    assert.equal(r.veredito, 'INTEGRO');
    assert.deepEqual(r.resumo.registros, { padrao: 0, empresa: 0, total: 0 });
    assert.deepEqual(r.alertas, []);
  });

  test('VER-08 — a leitura do banco é paginada por chave: com página de 2, todos os registros são conferidos, sem repetir nem pular', async () => {
    const raiz = novaRaiz();
    const padroes = [1, 2, 3, 4, 5].map((id) => h.criarImagemPadrao(raiz, { id, agora: AGORA }));
    const empresas = [10, 11, 12, 13, 14, 15, 16].map((id) => h.criarImagemEmpresa(raiz, { id, empresaId: 7, agora: AGORA }));
    const banco = h.poolFalso({ padrao: padroes.map((p) => p.linha).reverse(), empresa: empresas.map((e) => e.linha).reverse() });
    const r = await verificar(raiz, banco, { tamanhoDaPagina: 2 });
    assert.equal(r.veredito, 'INTEGRO');
    assert.deepEqual(r.resumo.registros, { padrao: 5, empresa: 7, total: 12 });
    assert.equal(r.resumo.arquivos.esperados, 5 * 2 + 7 * 3);
    assert.equal(banco.sql.filter((s) => /FROM imagens_padrao/i.test(s)).length, 3, '5 registros em páginas de 2: três consultas (a página curta encerra a leitura)');
    assert.equal(banco.sql.filter((s) => /FROM imagens_empresa/i.test(s)).length, 4);
  });

  test('VER-09 — os arquivos gravados PELO armazenamento real (permissões, nomes e extensões) são reconhecidos como íntegros', async () => {
    const { criarArmazenamentoImagens, chaveDe } = exigirModulo('src/storage/armazenamento-imagens');
    const raiz = novaRaiz();
    const armazenamento = criarArmazenamentoImagens({ diretorio: raiz });
    const padrao = { id: '1', formato: 'PNG' };
    const mestrePadrao = h.conteudoDe('PNG', 'real-p-m');
    const miniaturaPadrao = h.conteudoDe('WEBP', 'real-p-n');
    padrao.sha = h.sha(mestrePadrao);
    await armazenamento.gravar(chaveDe({ escopo: 'PADRAO', sha256: padrao.sha, variante: 'mestre', formato: 'PNG' }), mestrePadrao, { maxBytes: 10000 });
    await armazenamento.gravar(chaveDe({ escopo: 'PADRAO', sha256: padrao.sha, variante: 'miniatura', formato: 'WEBP' }), miniaturaPadrao, { maxBytes: 10000 });
    const envio = h.hex64('envio-real');
    const mestre = h.conteudoDe('JPEG', 'real-e-m');
    const exibicao = h.conteudoDe('WEBP', 'real-e-x');
    const miniatura = h.conteudoDe('WEBP', 'real-e-n');
    for (const [variante, formato, conteudo] of [['mestre', 'JPEG', mestre], ['exibicao', 'WEBP', exibicao], ['miniatura', 'WEBP', miniatura]]) {
      await armazenamento.gravar(chaveDe({ escopo: 'EMPRESA', empresaId: 5, sha256: envio, variante, formato }), conteudo, { maxBytes: 10000 });
    }
    const banco = h.poolFalso({
      padrao: [{ id: '1', sha256: padrao.sha, sha256_miniatura: h.sha(miniaturaPadrao), sha256_exibicao: null, formato: 'PNG', bytes_mestre: mestrePadrao.length, bytes_miniatura: miniaturaPadrao.length, bytes_exibicao: null }],
      empresa: [{
        id: '2', empresa_id: 5, sha256: envio, sha256_mestre: h.sha(mestre), sha256_exibicao: h.sha(exibicao), sha256_miniatura: h.sha(miniatura), formato: 'JPEG', bytes_mestre: mestre.length, bytes_exibicao: exibicao.length, bytes_miniatura: miniatura.length,
      }],
    });
    const r = await verificar(raiz, banco);
    assert.equal(r.veredito, 'INTEGRO', JSON.stringify(r.imagens));
    assert.equal(r.resumo.arquivos.integros, 5);
  });
});

describe('[VER] registro sem arquivo (RECUPERÁVEL)', () => {
  test('VER-10 — uma variante ausente: RECUPERAVEL com a variante e a chave; as outras seguem íntegras', async () => {
    const raiz = novaRaiz();
    const e10 = h.criarImagemEmpresa(raiz, { id: 10, empresaId: 7, agora: AGORA });
    const faltando = h.criarImagemEmpresa(raiz, { id: 30, empresaId: 7, agora: AGORA, ausentes: ['miniatura'] });
    const r = await verificar(raiz, h.poolFalso({ empresa: [e10.linha, faltando.linha] }));
    assert.equal(r.veredito, 'RECUPERAVEL');
    const imagem = doAchado(r, 30);
    assert.equal(imagem.classe, 'RECUPERAVEL');
    assert.equal(imagem.escopo, 'EMPRESA');
    assert.equal(imagem.empresaId, 7);
    assert.deepEqual(imagem.achados, [{ variante: 'miniatura', tipo: 'ARQUIVO_AUSENTE', classe: 'RECUPERAVEL', chave: faltando.chaves.miniatura }]);
    assert.deepEqual(r.resumo.arquivos, { esperados: 6, integros: 5, ausentes: 1, divergentes: 0, naoVerificados: 0 });
    assert.equal(doAchado(r, 10), undefined, 'a imagem íntegra não é listada');
  });

  test('VER-11 — pasta da imagem ausente e pasta da empresa ausente: todas as variantes esperadas ficam RECUPERAVEL', async () => {
    const raiz = novaRaiz();
    const semPasta = h.criarImagemEmpresa(raiz, { id: 31, empresaId: 7, agora: AGORA, ausentes: ['mestre', 'exibicao', 'miniatura'] });
    const semEmpresa = h.criarImagemEmpresa(raiz, { id: 32, empresaId: 8, agora: AGORA, ausentes: ['mestre', 'exibicao', 'miniatura'] });
    const outra = h.criarImagemEmpresa(raiz, { id: 33, empresaId: 7, agora: AGORA });
    const r = await verificar(raiz, h.poolFalso({ empresa: [semPasta.linha, semEmpresa.linha, outra.linha] }));
    assert.deepEqual(tipos(doAchado(r, 31)), ['mestre:ARQUIVO_AUSENTE', 'exibicao:ARQUIVO_AUSENTE', 'miniatura:ARQUIVO_AUSENTE']);
    assert.deepEqual(tipos(doAchado(r, 32)), ['mestre:ARQUIVO_AUSENTE', 'exibicao:ARQUIVO_AUSENTE', 'miniatura:ARQUIVO_AUSENTE']);
    assert.equal(r.veredito, 'RECUPERAVEL');
    assert.equal(r.resumo.arquivos.ausentes, 6);
  });

  test('VER-12 — a biblioteca padrão: o mestre e a miniatura são cobrados; a exibição só quando registrada', async () => {
    const raiz = novaRaiz();
    const semMestre = h.criarImagemPadrao(raiz, { id: 1, agora: AGORA, ausentes: ['mestre'] });
    const semExibicao = h.criarImagemPadrao(raiz, { id: 2, comExibicao: true, agora: AGORA, ausentes: ['exibicao'] });
    const r = await verificar(raiz, h.poolFalso({ padrao: [semMestre.linha, semExibicao.linha] }));
    assert.deepEqual(tipos(doAchado(r, 1, 'PADRAO')), ['mestre:ARQUIVO_AUSENTE']);
    assert.deepEqual(tipos(doAchado(r, 2, 'PADRAO')), ['exibicao:ARQUIVO_AUSENTE']);
    assert.equal(doAchado(r, 1, 'PADRAO').empresaId, null);
    assert.equal(r.resumo.arquivos.esperados, 2 + 3);
  });

  test('VER-13 — o mestre ausente com OUTRA extensão presente é inconsistência de formato (INVESTIGAR), não "ausente"; a sobra não é contada de novo como órfã', async () => {
    const raiz = novaRaiz();
    const imagem = h.criarImagemEmpresa(raiz, { id: 40, empresaId: 7, formato: 'PNG', agora: AGORA, ausentes: ['mestre'] });
    h.gravarNaRaiz(raiz, `7/${imagem.shaEnvio}/mestre.jpg`, h.conteudoDe('JPEG', 'outro'), { agora: AGORA });
    const r = await verificar(raiz, h.poolFalso({ empresa: [imagem.linha] }));
    const achado = doAchado(r, 40);
    assert.equal(achado.classe, 'INVESTIGAR');
    assert.deepEqual(achado.achados, [{ variante: 'mestre', tipo: 'FORMATO_DIVERGENTE', classe: 'INVESTIGAR', chave: imagem.chaves.mestre, encontrado: 'mestre.jpg' }]);
    assert.deepEqual(doArmazenamento(r, 'ORFAO_VARIANTE'), []);
    assert.equal(r.veredito, 'INVESTIGAR');
  });
});

describe('[VER] arquivo corrompido ou divergente do registro (INVESTIGAR)', () => {
  test('VER-14 — tamanho diferente do registro: TAMANHO_DIVERGENTE, e o conteúdo nem chega a ser aberto', async () => {
    const raiz = novaRaiz();
    const imagem = h.criarImagemEmpresa(raiz, { id: 50, empresaId: 7, agora: AGORA });
    fs.appendFileSync(imagem.caminho('miniatura'), 'x');
    const { fs: fachada, chamadas } = h.fachadaDeLeitura(raiz);
    const r = await verificar(raiz, h.poolFalso({ empresa: [imagem.linha] }), { fs: fachada });
    const achado = doAchado(r, 50).achados[0];
    assert.deepEqual(achado, { variante: 'miniatura', tipo: 'TAMANHO_DIVERGENTE', classe: 'INVESTIGAR', chave: imagem.chaves.miniatura, esperado: imagem.linha.bytes_miniatura, encontrado: imagem.linha.bytes_miniatura + 1 });
    assert.equal(chamadas.some((c) => c.metodo === 'open' && c.rel.endsWith('miniatura.webp')), false, 'tamanho divergente dispensa a leitura do conteúdo');
    assert.equal(r.veredito, 'INVESTIGAR');
  });

  test('VER-15 — arquivo zerado (truncado) é TAMANHO_DIVERGENTE', async () => {
    const raiz = novaRaiz();
    const imagem = h.criarImagemEmpresa(raiz, { id: 51, empresaId: 7, agora: AGORA });
    fs.writeFileSync(imagem.caminho('mestre'), Buffer.alloc(0));
    const r = await verificar(raiz, h.poolFalso({ empresa: [imagem.linha] }));
    const achado = doAchado(r, 51).achados[0];
    assert.equal(achado.tipo, 'TAMANHO_DIVERGENTE');
    assert.equal(achado.encontrado, 0);
    assert.equal(achado.esperado, imagem.linha.bytes_mestre);
  });

  test('VER-16 — mesmo tamanho e um byte trocado: SHA256_DIVERGENTE, com o hash esperado e o encontrado', async () => {
    const raiz = novaRaiz();
    const imagem = h.criarImagemEmpresa(raiz, { id: 52, empresaId: 7, agora: AGORA });
    const alterado = Buffer.from(imagem.conteudos.exibicao);
    alterado[100] ^= 0xff;
    fs.writeFileSync(imagem.caminho('exibicao'), alterado);
    const r = await verificar(raiz, h.poolFalso({ empresa: [imagem.linha] }));
    assert.deepEqual(doAchado(r, 52).achados, [{
      variante: 'exibicao', tipo: 'SHA256_DIVERGENTE', classe: 'INVESTIGAR', chave: imagem.chaves.exibicao, esperado: imagem.linha.sha256_exibicao, encontrado: h.sha(alterado),
    }]);
  });

  test('VER-17 — padrão: o mestre adulterado diverge do SHA-256 que dá nome à pasta e consta no registro', async () => {
    const raiz = novaRaiz();
    const padrao = h.criarImagemPadrao(raiz, { id: 3, agora: AGORA });
    const alterado = Buffer.from(padrao.conteudos.mestre);
    alterado[50] ^= 0x01;
    fs.writeFileSync(padrao.caminho('mestre'), alterado);
    const r = await verificar(raiz, h.poolFalso({ padrao: [padrao.linha] }));
    assert.equal(doAchado(r, 3, 'PADRAO').achados[0].tipo, 'SHA256_DIVERGENTE');
    assert.equal(doAchado(r, 3, 'PADRAO').achados[0].esperado, padrao.shaMestre);
  });

  test('VER-18 — o SHA-256 confere, mas o conteúdo não tem a assinatura do formato registrado: ASSINATURA_DIVERGENTE (registro e arquivo se contradizem)', async () => {
    const raiz = novaRaiz();
    const envio = h.hex64('envio-assinatura');
    const jpeg = h.conteudoDe('JPEG', 'assinatura-m');
    const png = h.conteudoDe('PNG', 'assinatura-x');
    const webp = h.conteudoDe('WEBP', 'assinatura-n');
    h.gravarNaRaiz(raiz, `7/${envio}/mestre.png`, jpeg, { agora: AGORA });
    h.gravarNaRaiz(raiz, `7/${envio}/exibicao.webp`, png, { agora: AGORA });
    h.gravarNaRaiz(raiz, `7/${envio}/miniatura.webp`, webp, { agora: AGORA });
    const linha = {
      id: '60', empresa_id: 7, sha256: envio, sha256_mestre: h.sha(jpeg), sha256_exibicao: h.sha(png), sha256_miniatura: h.sha(webp), formato: 'PNG',
      bytes_mestre: jpeg.length, bytes_exibicao: png.length, bytes_miniatura: webp.length,
    };
    const r = await verificar(raiz, h.poolFalso({ empresa: [linha] }));
    assert.deepEqual(tipos(doAchado(r, 60)), ['mestre:ASSINATURA_DIVERGENTE', 'exibicao:ASSINATURA_DIVERGENTE']);
    assert.equal(doAchado(r, 60).classe, 'INVESTIGAR');
  });

  test('VER-19 — a pior classe vence: uma variante ausente (RECUPERAVEL) com outra corrompida (INVESTIGAR) deixa a imagem INVESTIGAR, achados na ordem mestre, exibição, miniatura', async () => {
    const raiz = novaRaiz();
    const imagem = h.criarImagemEmpresa(raiz, { id: 61, empresaId: 7, agora: AGORA, ausentes: ['miniatura'] });
    const alterado = Buffer.from(imagem.conteudos.mestre);
    alterado[120] ^= 0x10;
    fs.writeFileSync(imagem.caminho('mestre'), alterado);
    const r = await verificar(raiz, h.poolFalso({ empresa: [imagem.linha] }));
    assert.equal(doAchado(r, 61).classe, 'INVESTIGAR');
    assert.deepEqual(tipos(doAchado(r, 61)), ['mestre:SHA256_DIVERGENTE', 'miniatura:ARQUIVO_AUSENTE']);
    assert.deepEqual(r.resumo.imagens, { INTEGRO: 0, RECUPERAVEL: 0, INVESTIGAR: 1 });
  });
});

describe('[VER] arquivos sem registro (órfãos) e resíduos', () => {
  test('VER-20 — conjunto completo sem registro e com idade: ORFAO_CONJUNTO (não é dano), com variantes, bytes e idade; veredito ORFAO', async () => {
    const raiz = novaRaiz();
    const e10 = h.criarImagemEmpresa(raiz, { id: 10, empresaId: 7, agora: AGORA });
    const hash = h.hex64('orfao-completo');
    const conteudos = { 'mestre.png': h.conteudoDe('PNG', 'o-m', 300), 'exibicao.webp': h.conteudoDe('WEBP', 'o-x', 200), 'miniatura.webp': h.conteudoDe('WEBP', 'o-n', 100) };
    for (const [nome, conteudo] of Object.entries(conteudos)) h.gravarNaRaiz(raiz, `7/${hash}/${nome}`, conteudo, { agora: AGORA, minutosAtras: 3 * DIA });
    const r = await verificar(raiz, h.poolFalso({ empresa: [e10.linha] }));
    assert.equal(r.veredito, 'ORFAO');
    assert.deepEqual(r.imagens, []);
    assert.equal(r.armazenamento.length, 1);
    assert.deepEqual(r.armazenamento[0], {
      tipo: 'ORFAO_CONJUNTO', classe: 'ORFAO', escopo: 'EMPRESA', empresaId: 7, hash, arquivos: ['exibicao.webp', 'mestre.png', 'miniatura.webp'], bytes: 600, idadeMinutos: 3 * DIA, recente: false,
    });
    assert.equal(r.resumo.armazenamento.conjuntosOrfaos, 1);
  });

  test('VER-21 — falha entre gravações: só o mestre e a exibição foram gravados e o INSERT nunca veio — conjunto parcial órfão, nunca registro sem arquivo', async () => {
    const raiz = novaRaiz();
    const hash = h.hex64('falha-entre-gravacoes');
    h.gravarNaRaiz(raiz, `padrao/${hash}/mestre.png`, h.conteudoDe('PNG', 'f-m'), { agora: AGORA, minutosAtras: 2 * DIA });
    h.gravarNaRaiz(raiz, `padrao/${hash}/exibicao.webp`, h.conteudoDe('WEBP', 'f-x'), { agora: AGORA, minutosAtras: 2 * DIA });
    const r = await verificar(raiz, h.poolFalso(comRegistroBase(raiz)));
    assert.equal(r.veredito, 'ORFAO');
    assert.deepEqual(r.armazenamento.map((a) => [a.tipo, a.escopo, a.hash, a.arquivos]), [['ORFAO_CONJUNTO', 'PADRAO', hash, ['exibicao.webp', 'mestre.png']]]);
    assert.equal(r.armazenamento[0].empresaId, null);
  });

  test('VER-22 — órfão recente (mais novo que a idade mínima) pode ser um envio em andamento: fica em `recente`, fora dos contadores e do veredito', async () => {
    const raiz = novaRaiz();
    const hash = h.hex64('envio-em-andamento');
    h.gravarNaRaiz(raiz, `padrao/${hash}/mestre.png`, h.conteudoDe('PNG', 'andamento'), { agora: AGORA, minutosAtras: 10 });
    const r = await verificar(raiz, h.poolFalso(comRegistroBase(raiz)));
    assert.equal(r.veredito, 'INTEGRO');
    assert.equal(r.armazenamento[0].recente, true);
    assert.equal(r.armazenamento[0].idadeMinutos, 10);
    assert.equal(r.resumo.armazenamento.conjuntosOrfaos, 0);
    assert.equal(r.resumo.armazenamento.recentes, 1);
  });

  test('VER-23 — a idade mínima é configurável (0 conta tudo; o limite exato conta como antigo)', async () => {
    const raiz = novaRaiz();
    const hash = h.hex64('idade-configuravel');
    h.gravarNaRaiz(raiz, `padrao/${hash}/mestre.png`, h.conteudoDe('PNG', 'idade'), { agora: AGORA, minutosAtras: 30 });
    const base = comRegistroBase(raiz);
    assert.equal((await verificar(raiz, h.poolFalso(base), { idadeMinimaOrfaoMinutos: 0 })).veredito, 'ORFAO');
    assert.equal((await verificar(raiz, h.poolFalso(base), { idadeMinimaOrfaoMinutos: 31 })).veredito, 'INTEGRO');
    assert.equal((await verificar(raiz, h.poolFalso(base), { idadeMinimaOrfaoMinutos: 30 })).veredito, 'ORFAO', 'idade igual ao limite já é órfão');
    assert.equal((await verificar(raiz, h.poolFalso(base))).idadeMinimaOrfaoMinutos, DIA, 'o padrão é 24 horas (decisão D-C3)');
  });

  test('VER-24 — resíduo .tmp de publicação interrompida: TEMPORARIO_RESIDUAL (antigo é ORFAO; recente é envio em andamento)', async () => {
    const raiz = novaRaiz();
    const e10 = h.criarImagemEmpresa(raiz, { id: 10, empresaId: 7, agora: AGORA });
    h.gravarNaRaiz(raiz, `7/${e10.shaEnvio}/mestre.png.0123456789abcdef.tmp`, Buffer.from('parcial-antigo'), { agora: AGORA, minutosAtras: 2 * DIA });
    h.gravarNaRaiz(raiz, `7/${e10.shaEnvio}/miniatura.webp.fedcba9876543210.tmp`, Buffer.from('parcial-novo'), { agora: AGORA, minutosAtras: 1 });
    const r = await verificar(raiz, h.poolFalso({ empresa: [e10.linha] }));
    const residuos = doArmazenamento(r, 'TEMPORARIO_RESIDUAL');
    assert.deepEqual(residuos.map((x) => [x.arquivos, x.classe, x.recente]), [[['mestre.png.0123456789abcdef.tmp'], 'ORFAO', false], [['miniatura.webp.fedcba9876543210.tmp'], 'ORFAO', true]]);
    assert.equal(r.veredito, 'ORFAO');
    assert.equal(r.resumo.armazenamento.temporarios, 1);
  });

  test('VER-25 — variante extra dentro da pasta de um registro (exibição não registrada no padrão; mestre.jpg ao lado do mestre.png): ORFAO_VARIANTE', async () => {
    const raiz = novaRaiz();
    const padrao = h.criarImagemPadrao(raiz, { id: 4, agora: AGORA });
    h.gravarNaRaiz(raiz, `${padrao.pasta}/exibicao.webp`, h.conteudoDe('WEBP', 'extra-x'), { agora: AGORA });
    const empresa = h.criarImagemEmpresa(raiz, { id: 70, empresaId: 7, formato: 'PNG', agora: AGORA });
    h.gravarNaRaiz(raiz, `${empresa.pasta}/mestre.jpg`, h.conteudoDe('JPEG', 'extra-m'), { agora: AGORA });
    const r = await verificar(raiz, h.poolFalso({ padrao: [padrao.linha], empresa: [empresa.linha] }));
    const extras = doArmazenamento(r, 'ORFAO_VARIANTE');
    assert.deepEqual(extras.map((x) => [x.escopo, x.arquivos]).sort(), [['EMPRESA', ['mestre.jpg']], ['PADRAO', ['exibicao.webp']]]);
    assert.equal(r.veredito, 'ORFAO');
    assert.equal(r.resumo.armazenamento.variantesOrfas, 2);
  });

  test('VER-26 — pasta de imagem vazia e sem registro: ORFAO_CONJUNTO sem arquivos (idade pela própria pasta)', SO_POSIX, async () => {
    const raiz = novaRaiz();
    const hash = h.hex64('pasta-vazia');
    fs.mkdirSync(path.join(raiz, '7', hash), { recursive: true, mode: 0o700 });
    const antiga = (AGORA - 5 * DIA * MIN) / 1000;
    fs.utimesSync(path.join(raiz, '7', hash), antiga, antiga);
    const r = await verificar(raiz, h.poolFalso(comRegistroBase(raiz, { empresas: [7] })));
    assert.deepEqual(r.armazenamento.map((a) => [a.tipo, a.arquivos, a.bytes, a.idadeMinutos]), [['ORFAO_CONJUNTO', [], 0, 5 * DIA]]);
  });

  test('VER-27 — arquivos de uma empresa que NÃO existe no banco não são "sobra": podem ser de outro ambiente (INVESTIGAR)', async () => {
    const raiz = novaRaiz();
    const hash = h.hex64('empresa-fantasma');
    h.gravarNaRaiz(raiz, `99/${hash}/mestre.png`, h.conteudoDe('PNG', 'fantasma'), { agora: AGORA, minutosAtras: 4 * DIA });
    const r = await verificar(raiz, h.poolFalso(comRegistroBase(raiz, { empresas: [7] })));
    assert.deepEqual(r.armazenamento.map((a) => [a.tipo, a.classe, a.empresaId]), [['ORFAO_EMPRESA_INEXISTENTE', 'INVESTIGAR', 99]]);
    assert.equal(r.veredito, 'INVESTIGAR');
  });
});

describe('[VER] caminhos impróprios, links simbólicos e entradas estranhas', () => {
  test('VER-28 — link simbólico NO LUGAR de um arquivo esperado: ENTRADA_INVALIDA; o alvo (com os bytes certos, fora da raiz) nunca é aberto nem seguido', SO_POSIX, async () => {
    const raiz = novaRaiz();
    const fora = novaRaiz();
    const imagem = h.criarImagemEmpresa(raiz, { id: 80, empresaId: 7, agora: AGORA });
    const alvo = path.join(fora, 'alvo.webp');
    fs.writeFileSync(alvo, imagem.conteudos.miniatura);
    fs.rmSync(imagem.caminho('miniatura'));
    fs.symlinkSync(alvo, imagem.caminho('miniatura'));
    const { fs: fachada, chamadas } = h.fachadaDeLeitura(raiz);
    const r = await verificar(raiz, h.poolFalso({ empresa: [imagem.linha] }), { fs: fachada });
    assert.deepEqual(doAchado(r, 80).achados, [{ variante: 'miniatura', tipo: 'ENTRADA_INVALIDA', classe: 'INVESTIGAR', chave: imagem.chaves.miniatura, componente: 'ARQUIVO', encontrado: 'LINK_SIMBOLICO' }]);
    assert.equal(chamadas.some((c) => c.metodo === 'open' && c.rel.endsWith('miniatura.webp')), false, 'o link não é aberto');
    assert.equal(chamadas.some((c) => c.rel.startsWith('..')), false, 'nada fora da raiz é tocado');
    const solto = r.armazenamento.filter((a) => a.tipo === 'ENTRADA_INESPERADA');
    assert.deepEqual(solto, [], 'o arquivo esperado (mesmo que seja link) não é reportado de novo como sobra');
  });

  test('VER-29 — link simbólico no lugar da PASTA da imagem e da PASTA da empresa: os registros ficam ENTRADA_INVALIDA e nada do alvo é listado nem lido', SO_POSIX, async () => {
    const raiz = novaRaiz();
    const fora = novaRaiz();
    const emLink = h.criarImagemEmpresa(raiz, { id: 81, empresaId: 7, agora: AGORA });
    const empresaLink = h.criarImagemEmpresa(raiz, { id: 82, empresaId: 8, agora: AGORA });
    fs.renameSync(path.join(raiz, emLink.pasta), path.join(fora, 'pasta-imagem'));
    fs.symlinkSync(path.join(fora, 'pasta-imagem'), path.join(raiz, emLink.pasta));
    fs.renameSync(path.join(raiz, '8'), path.join(fora, 'pasta-empresa'));
    fs.symlinkSync(path.join(fora, 'pasta-empresa'), path.join(raiz, '8'));
    const { fs: fachada, chamadas } = h.fachadaDeLeitura(raiz);
    const r = await verificar(raiz, h.poolFalso({ empresa: [emLink.linha, empresaLink.linha] }), { fs: fachada });
    assert.deepEqual(doAchado(r, 81).achados.map((a) => [a.tipo, a.componente, a.encontrado]), Array(3).fill(['ENTRADA_INVALIDA', 'PASTA_IMAGEM', 'LINK_SIMBOLICO']));
    assert.deepEqual(doAchado(r, 82).achados.map((a) => [a.tipo, a.componente, a.encontrado]), Array(3).fill(['ENTRADA_INVALIDA', 'PASTA_EMPRESA', 'LINK_SIMBOLICO']));
    assert.equal(chamadas.some((c) => c.metodo === 'open'), false, 'nenhum arquivo foi aberto através de link');
    assert.equal(chamadas.some((c) => c.metodo === 'readdir' && (c.rel === '8' || c.rel === emLink.pasta)), false, 'os links não foram listados');
    assert.equal(chamadas.some((c) => c.rel.startsWith('..')), false);
    assert.ok(r.armazenamento.some((a) => a.tipo === 'ENTRADA_INESPERADA' && a.onde === 'PASTA_EMPRESA' && a.encontrado === 'LINK_SIMBOLICO'), 'o link da pasta da empresa aparece na varredura');
    assert.ok(r.armazenamento.some((a) => a.tipo === 'ENTRADA_INESPERADA' && a.onde === 'RAIZ' && a.encontrado === 'LINK_SIMBOLICO'), 'o link do namespace na raiz também');
  });

  test('VER-30 — links soltos em qualquer nível da árvore são ENTRADA_INESPERADA e nunca são seguidos', SO_POSIX, async () => {
    const raiz = novaRaiz();
    const fora = novaRaiz();
    const imagem = h.criarImagemEmpresa(raiz, { id: 83, empresaId: 7, agora: AGORA });
    fs.mkdirSync(path.join(fora, 'dir'));
    fs.symlinkSync(path.join(fora, 'dir'), path.join(raiz, 'link-da-raiz'));
    fs.symlinkSync(path.join(fora, 'dir'), path.join(raiz, '7', 'link-da-empresa'));
    fs.symlinkSync(path.join(fora, 'dir'), path.join(raiz, imagem.pasta, 'link-da-imagem'));
    const { fs: fachada, chamadas } = h.fachadaDeLeitura(raiz);
    const r = await verificar(raiz, h.poolFalso({ empresa: [imagem.linha] }), { fs: fachada });
    assert.deepEqual(doArmazenamento(r, 'ENTRADA_INESPERADA').map((a) => [a.onde, a.nome, a.encontrado]).sort(), [
      ['PASTA_EMPRESA', 'link-da-empresa', 'LINK_SIMBOLICO'], ['PASTA_IMAGEM', 'link-da-imagem', 'LINK_SIMBOLICO'], ['RAIZ', 'link-da-raiz', 'LINK_SIMBOLICO'],
    ]);
    assert.equal(chamadas.some((c) => c.rel.includes('link-da')), false, 'um link solto não é aberto, listado nem inspecionado');
    assert.equal(r.veredito, 'INVESTIGAR');
  });

  test('VER-31 — nomes hostis (escape de terminal, quebra de linha, bidirecional, enormes, traversal) viram ENTRADA_INESPERADA com nome ESCAPADO e nunca entram num caminho', SO_POSIX, async () => {
    const raiz = novaRaiz();
    const imagem = h.criarImagemEmpresa(raiz, { id: 84, empresaId: 7, agora: AGORA });
    const nomes = ['\u001b[31mVERMELHO\u001b[0m', 'linha1\nlinha2', `gpj.‮txt`, 'a'.repeat(250), '%2e%2e', '-rf', '...', 'a b'];
    for (const nome of nomes) {
      fs.writeFileSync(path.join(raiz, nome), 'x');
      fs.writeFileSync(path.join(raiz, '7', nome), 'x');
      fs.writeFileSync(path.join(raiz, imagem.pasta, nome), 'x');
    }
    const { fs: fachada, chamadas } = h.fachadaDeLeitura(raiz);
    const r = await verificar(raiz, h.poolFalso({ empresa: [imagem.linha] }), { fs: fachada });
    const estranhas = doArmazenamento(r, 'ENTRADA_INESPERADA');
    assert.equal(estranhas.length, nomes.length * 3);
    for (const entrada of estranhas) {
      assert.doesNotMatch(entrada.nome, PROIBIDOS, 'o nome sai escapado');
      assert.ok(Array.from(entrada.nome).length <= 161, 'o nome sai limitado');
      assert.equal(entrada.encontrado, 'ARQUIVO');
    }
    assert.doesNotMatch(JSON.stringify(r), PROIBIDOS);
    assert.equal(chamadas.some((c) => nomes.some((n) => c.rel.includes(n))), false, 'nenhum nome estranho virou caminho de lstat, open ou readdir');
  });

  test('VER-32 — estrutura estranha é reportada, não adivinhada: lost+found, .DS_Store, namespace com zero à esquerda, hash em maiúsculas, subpasta no lugar de arquivo', SO_POSIX, async () => {
    const raiz = novaRaiz();
    const imagem = h.criarImagemEmpresa(raiz, { id: 85, empresaId: 7, agora: AGORA });
    fs.mkdirSync(path.join(raiz, 'lost+found'));
    fs.writeFileSync(path.join(raiz, '.DS_Store'), 'x');
    fs.mkdirSync(path.join(raiz, '007'));
    fs.mkdirSync(path.join(raiz, '7', 'A'.repeat(64)));
    fs.mkdirSync(path.join(raiz, imagem.pasta, 'subpasta'));
    fs.writeFileSync(path.join(raiz, imagem.pasta, 'README.txt'), 'x');
    const r = await verificar(raiz, h.poolFalso({ empresa: [imagem.linha] }));
    assert.deepEqual(doArmazenamento(r, 'ENTRADA_INESPERADA').map((a) => [a.onde, a.nome, a.encontrado]).sort(), [
      ['PASTA_EMPRESA', 'A'.repeat(64), 'DIRETORIO'], ['PASTA_IMAGEM', 'README.txt', 'ARQUIVO'], ['PASTA_IMAGEM', 'subpasta', 'DIRETORIO'],
      ['RAIZ', '.DS_Store', 'ARQUIVO'], ['RAIZ', '007', 'DIRETORIO'], ['RAIZ', 'lost+found', 'DIRETORIO'],
    ].sort());
    assert.equal(r.resumo.armazenamento.entradasInesperadas, 6);
  });

  test('VER-33 — registro inconsistente (hash, formato, tamanho, empresa, exibição pela metade): REGISTRO_INVALIDO com o NOME do campo, sem tocar o disco e sem lançar', async () => {
    const raiz = novaRaiz();
    const base = h.criarImagemEmpresa(raiz, { id: 90, empresaId: 7, agora: AGORA });
    const ruim = (id, mudanca) => ({ ...base.linha, id: String(id), ...mudanca });
    const padraoBase = h.criarImagemPadrao(raiz, { id: 91, agora: AGORA });
    const { fs: fachada, chamadas } = h.fachadaDeLeitura(raiz);
    const banco = h.poolFalso({
      padrao: [
        { ...padraoBase.linha, id: '91', sha256: 'XYZ' },
        { ...padraoBase.linha, id: '92', sha256_exibicao: h.hex64('x'), bytes_exibicao: null },
      ],
      empresa: [ruim(93, { sha256: 'curto' }), ruim(94, { formato: 'GIF' }), ruim(95, { bytes_mestre: 0 }), ruim(96, { empresa_id: 0 }), ruim(97, { empresa_id: 1.5 }), ruim(98, { sha256_miniatura: null })],
      empresas: [7],
    });
    const r = await verificar(raiz, banco, { fs: fachada });
    const campos = Object.fromEntries(r.imagens.map((i) => [`${i.escopo}:${i.imagemId}`, i.achados.map((a) => [a.tipo, a.campo])]));
    assert.deepEqual(campos, {
      'PADRAO:91': [['REGISTRO_INVALIDO', 'sha256']],
      'PADRAO:92': [['REGISTRO_INVALIDO', 'exibicao']],
      'EMPRESA:93': [['REGISTRO_INVALIDO', 'sha256']],
      'EMPRESA:94': [['REGISTRO_INVALIDO', 'formato']],
      'EMPRESA:95': [['REGISTRO_INVALIDO', 'bytes_mestre']],
      'EMPRESA:96': [['REGISTRO_INVALIDO', 'empresa_id']],
      'EMPRESA:97': [['REGISTRO_INVALIDO', 'empresa_id']],
      'EMPRESA:98': [['REGISTRO_INVALIDO', 'sha256_miniatura']],
    });
    assert.equal(r.veredito, 'INVESTIGAR');
    assert.equal(chamadas.filter((c) => c.metodo === 'open').length, 0, 'registro inválido não gera leitura de arquivo');
  });

  test('VER-34 — raiz ausente: alerta RAIZ_AUSENTE, nada é criado e o banco nem é consultado (não declara dano em massa por um ponto de montagem errado)', async () => {
    const base = novaRaiz();
    const inexistente = path.join(base, 'nao-existe');
    const banco = h.poolFalso({ padrao: [{ id: '1', sha256: h.hex64('a'), sha256_miniatura: h.hex64('b'), sha256_exibicao: null, formato: 'PNG', bytes_mestre: 1, bytes_miniatura: 1, bytes_exibicao: null }] });
    const r = await verificar(inexistente, banco);
    assert.equal(r.veredito, 'INVESTIGAR');
    assert.deepEqual(r.alertas.map((a) => [a.codigo, a.classe]), [['RAIZ_AUSENTE', 'INVESTIGAR']]);
    assert.deepEqual(r.imagens, []);
    assert.equal(fs.existsSync(inexistente), false, 'a verificação não cria o diretório');
    assert.deepEqual(banco.eventos, [], 'sem raiz utilizável o banco não é consultado');
    assert.equal(r.resumo.registros.total, 0);
  });

  test('VER-35 — raiz que é um arquivo: RAIZ_INVALIDA; raiz ilegível: RAIZ_ILEGIVEL; raiz que é link para um diretório é aceita (como no armazenamento)', SO_POSIX, async () => {
    const base = novaRaiz();
    const arquivo = path.join(base, 'arquivo');
    fs.writeFileSync(arquivo, 'x');
    assert.deepEqual((await verificar(arquivo, h.poolFalso())).alertas.map((a) => a.codigo), ['RAIZ_INVALIDA']);

    const real = path.join(base, 'real');
    fs.mkdirSync(real);
    const imagem = h.criarImagemEmpresa(real, { id: 100, empresaId: 7, agora: AGORA });
    const link = path.join(base, 'link');
    fs.symlinkSync(real, link);
    assert.equal((await verificar(link, h.poolFalso({ empresa: [imagem.linha] }))).veredito, 'INTEGRO');

    const { fs: fachada } = h.fachadaDeLeitura(real, { falhas: [{ metodo: 'realpath', codigo: 'EACCES' }] });
    const ilegivel = await verificar(real, h.poolFalso(), { fs: fachada });
    assert.deepEqual(ilegivel.alertas.map((a) => [a.codigo, a.codigoSistema]), [['RAIZ_ILEGIVEL', 'EACCES']]);
  });

  test('VER-36 — argumentos inválidos são erro de programação (TypeError) antes de qualquer acesso', async () => {
    const raiz = novaRaiz();
    const { verificarArmazenamento } = M();
    const pool = h.poolFalso();
    for (const diretorio of [undefined, '', 'relativo/imagens', `${raiz}\0x`, 42]) {
      await assert.rejects(() => verificarArmazenamento(pool, { diretorio }), TypeError, String(diretorio));
    }
    for (const idade of [-1, 1.5, '60', 525601, Number.NaN]) {
      await assert.rejects(() => verificarArmazenamento(pool, { diretorio: raiz, idadeMinimaOrfaoMinutos: idade }), TypeError, String(idade));
    }
    for (const pagina of [0, 1001, 2.5]) {
      await assert.rejects(() => verificarArmazenamento(pool, { diretorio: raiz, tamanhoDaPagina: pagina }), TypeError, String(pagina));
    }
    await assert.rejects(() => verificarArmazenamento({}, { diretorio: raiz }), TypeError);
    await assert.rejects(() => verificarArmazenamento(pool, undefined), TypeError);
    assert.deepEqual(pool.eventos, []);
  });
});

describe('[VER] comportamento seguro quando a LEITURA falha', () => {
  test('VER-37 — erro ao abrir o arquivo (EACCES): LEITURA_FALHOU/não verificado — nunca íntegro, nunca ausente — e a verificação segue; a mensagem não leva caminho', async () => {
    const raiz = novaRaiz();
    const a = h.criarImagemEmpresa(raiz, { id: 110, empresaId: 7, agora: AGORA });
    const b = h.criarImagemEmpresa(raiz, { id: 111, empresaId: 7, agora: AGORA });
    const { fs: fachada } = h.fachadaDeLeitura(raiz, { falhas: [{ metodo: 'open', ondeTermina: `${a.pasta}/miniatura.webp`.split('/').join(path.sep), codigo: 'EACCES' }] });
    const r = await verificar(raiz, h.poolFalso({ empresa: [a.linha, b.linha] }), { fs: fachada });
    assert.deepEqual(doAchado(r, 110).achados, [{ variante: 'miniatura', tipo: 'LEITURA_FALHOU', classe: 'INVESTIGAR', chave: a.chaves.miniatura, codigoSistema: 'EACCES', naoVerificado: true }]);
    assert.equal(doAchado(r, 111), undefined, 'o outro registro foi conferido e está íntegro');
    assert.deepEqual(r.resumo.arquivos, { esperados: 6, integros: 5, ausentes: 0, divergentes: 0, naoVerificados: 1 });
    assert.equal(r.veredito, 'INVESTIGAR');
    assert.equal(JSON.stringify(r).includes(raiz), false, 'nenhum caminho absoluto no relatório');
  });

  test('VER-38 — erro no MEIO da leitura (EIO): LEITURA_FALHOU e o descritor é fechado', async () => {
    const raiz = novaRaiz();
    const imagem = h.criarImagemEmpresa(raiz, { id: 112, empresaId: 7, agora: AGORA });
    const { fs: fachada, abertos } = h.fachadaDeLeitura(raiz, { falhas: [{ metodo: 'read', ondeTermina: 'exibicao.webp', codigo: 'EIO' }] });
    const r = await verificar(raiz, h.poolFalso({ empresa: [imagem.linha] }), { fs: fachada });
    assert.deepEqual(doAchado(r, 112).achados.map((x) => [x.variante, x.tipo, x.codigoSistema]), [['exibicao', 'LEITURA_FALHOU', 'EIO']]);
    assert.equal(abertos.size, 0, 'nenhum descritor ficou aberto');
  });

  test('VER-39 — corrida: o arquivo some entre o lstat e o open (ENOENT) é ARQUIVO_AUSENTE; um link plantado nesse intervalo (ELOOP) é ENTRADA_INVALIDA', async () => {
    const raiz = novaRaiz();
    const a = h.criarImagemEmpresa(raiz, { id: 113, empresaId: 7, agora: AGORA });
    const b = h.criarImagemEmpresa(raiz, { id: 114, empresaId: 7, agora: AGORA });
    const { fs: fachada } = h.fachadaDeLeitura(raiz, { falhas: [
      { metodo: 'open', ondeTermina: `${a.pasta}/mestre.png`.split('/').join(path.sep), codigo: 'ENOENT' },
      { metodo: 'open', ondeTermina: `${b.pasta}/mestre.png`.split('/').join(path.sep), codigo: 'ELOOP' },
    ] });
    const r = await verificar(raiz, h.poolFalso({ empresa: [a.linha, b.linha] }), { fs: fachada });
    assert.deepEqual(doAchado(r, 113).achados.map((x) => x.tipo), ['ARQUIVO_AUSENTE']);
    assert.deepEqual(doAchado(r, 114).achados.map((x) => [x.tipo, x.encontrado]), [['ENTRADA_INVALIDA', 'LINK_SIMBOLICO']]);
  });

  test('VER-40 — falha ao LISTAR uma pasta: a pasta vira LEITURA_FALHOU (as sobras dela ficam não verificadas), a conferência direta dos registros continua; a raiz ilegível vira alerta', async () => {
    const raiz = novaRaiz();
    const imagem = h.criarImagemEmpresa(raiz, { id: 115, empresaId: 7, agora: AGORA });
    const { fs: fachada } = h.fachadaDeLeitura(raiz, { falhas: [{ metodo: 'readdir', ondeIgual: '7', codigo: 'EACCES' }] });
    const r = await verificar(raiz, h.poolFalso({ empresa: [imagem.linha] }), { fs: fachada });
    assert.deepEqual(r.imagens, [], 'os registros foram conferidos diretamente e estão íntegros');
    assert.deepEqual(r.armazenamento.map((a) => [a.tipo, a.onde, a.empresaId, a.codigoSistema, a.naoVerificado]), [['LEITURA_FALHOU', 'PASTA_EMPRESA', 7, 'EACCES', true]]);
    assert.equal(r.veredito, 'INVESTIGAR');

    const { fs: fachadaRaiz } = h.fachadaDeLeitura(raiz, { falhas: [{ metodo: 'readdir', ondeIgual: '', codigo: 'EIO' }] });
    const semRaiz = await verificar(raiz, h.poolFalso({ empresa: [imagem.linha] }), { fs: fachadaRaiz });
    assert.deepEqual(semRaiz.alertas.map((a) => [a.codigo, a.codigoSistema]), [['RAIZ_ILEGIVEL', 'EIO']]);
    assert.equal(semRaiz.veredito, 'INVESTIGAR');
  });

  test('VER-41 — falha do banco propaga (sem relatório parcial), com ROLLBACK e a conexão liberada', async () => {
    const raiz = novaRaiz();
    const { p1 } = cenarioIntegro(raiz);
    const banco = h.poolFalso({ padrao: [p1.linha], falharEm: 'FROM imagens_empresa' });
    await assert.rejects(() => verificar(raiz, banco), (erro) => erro.code === 'XX000');
    assert.deepEqual(banco.eventos, ['connect', 'release']);
    assert.equal(banco.sql.at(-1), 'ROLLBACK');
  });
});

describe('[VER] par banco/armazenamento, uso por material e relatório', () => {
  test('VER-42 — nenhum arquivo esperado existe (outro volume, restauração incompleta): alerta além dos "ausentes"', async () => {
    const raiz = novaRaiz();
    const fantasma = h.criarImagemEmpresa(novaRaiz(), { id: 120, empresaId: 7, agora: AGORA });
    const r = await verificar(raiz, h.poolFalso({ empresa: [fantasma.linha] }));
    assert.deepEqual(r.alertas.map((a) => [a.codigo, a.classe]), [['NENHUM_ARQUIVO_ESPERADO_PRESENTE', 'INVESTIGAR']]);
    assert.equal(r.resumo.arquivos.ausentes, 3);
    assert.equal(r.veredito, 'INVESTIGAR', 'o alerta eleva o veredito acima de RECUPERAVEL');
  });

  test('VER-43 — banco sem registros, mas com imagens antigas no armazenamento: alerta BANCO_SEM_REGISTROS_COM_ARQUIVOS', async () => {
    const raiz = novaRaiz();
    h.gravarNaRaiz(raiz, `padrao/${h.hex64('sobra')}/mestre.png`, h.conteudoDe('PNG', 'sobra'), { agora: AGORA, minutosAtras: 5 * DIA });
    const r = await verificar(raiz, h.poolFalso());
    assert.deepEqual(r.alertas.map((a) => a.codigo), ['BANCO_SEM_REGISTROS_COM_ARQUIVOS']);
    assert.equal(r.veredito, 'INVESTIGAR');
  });

  test('VER-44 — imagem não íntegra informa quantos materiais a usam (prioriza a recuperação); a íntegra não é listada', async () => {
    const raiz = novaRaiz();
    const quebrada = h.criarImagemEmpresa(raiz, { id: 130, empresaId: 7, agora: AGORA, ausentes: ['mestre'] });
    const padraoQuebrada = h.criarImagemPadrao(raiz, { id: 131, agora: AGORA, ausentes: ['miniatura'] });
    const integra = h.criarImagemEmpresa(raiz, { id: 132, empresaId: 7, agora: AGORA });
    const banco = h.poolFalso({
      padrao: [padraoQuebrada.linha],
      empresa: [quebrada.linha, integra.linha],
      usoPadrao: [{ imagem_id: '131', materiais: 4 }],
      usoEmpresa: [{ empresa_id: 7, imagem_id: '130', materiais: 2 }, { empresa_id: 7, imagem_id: '132', materiais: 9 }],
    });
    const r = await verificar(raiz, banco);
    assert.equal(doAchado(r, 130).materiaisEmUso, 2);
    assert.equal(doAchado(r, 131, 'PADRAO').materiaisEmUso, 4);
    assert.equal(doAchado(r, 132), undefined);
    const sem = await verificar(raiz, h.poolFalso({ empresa: [h.criarImagemEmpresa(novaRaiz(), { id: 133, empresaId: 7, agora: AGORA }).linha] }));
    assert.equal(sem.imagens[0].materiaisEmUso, 0);
  });

  test('VER-45 — o relatório é serializável, não leva caminho absoluto nem caractere de controle, e é determinístico (mesma entrada, mesmo relatório, qualquer ordem do banco)', async () => {
    const raiz = novaRaiz();
    const { e10, e11, e12, p1, p2 } = cenarioIntegro(raiz);
    const quebrada = h.criarImagemEmpresa(raiz, { id: 140, empresaId: 7, agora: AGORA, ausentes: ['exibicao'] });
    fs.writeFileSync(path.join(raiz, '7', `${'c'.repeat(64)}.x`), 'x');
    h.gravarNaRaiz(raiz, `9/${h.hex64('orfao-9')}/miniatura.webp`, h.conteudoDe('WEBP', 'o9'), { agora: AGORA, minutosAtras: 2 * DIA });
    const linhas = { padrao: [p1.linha, p2.linha], empresa: [e10.linha, e11.linha, e12.linha, quebrada.linha] };
    const primeiro = await verificar(raiz, h.poolFalso(linhas));
    const invertido = h.fachadaDeLeitura(raiz, { inverterListagens: true });
    const segundo = await verificar(raiz, h.poolFalso({ padrao: [...linhas.padrao].reverse(), empresa: [...linhas.empresa].reverse() }), { fs: invertido.fs });
    assert.deepEqual(primeiro, segundo, 'a ordem do relatório não depende da ordem das listagens do sistema de arquivos');
    const texto = JSON.stringify(primeiro);
    assert.deepEqual(JSON.parse(texto), primeiro);
    assert.equal(texto.includes(raiz), false);
    assert.doesNotMatch(texto, PROIBIDOS);
    assert.deepEqual(primeiro.imagens.map((i) => [i.escopo, i.empresaId, i.imagemId]), [['EMPRESA', 7, '140']]);
  });

  test('VER-46 — identificarBanco devolve nome e OID da conexão (para o operador conferir o par banco/armazenamento) com uma única consulta SELECT', async () => {
    const pool = h.poolFalso({ banco: { nome: 'gestao_epi_teste_local', oid: '16384' } });
    assert.deepEqual(await M().identificarBanco(pool), { nome: 'gestao_epi_teste_local', oid: '16384' });
    assert.equal(pool.sql.length, 1);
    assert.match(pool.sql[0], /^SELECT\b/);
  });
});
