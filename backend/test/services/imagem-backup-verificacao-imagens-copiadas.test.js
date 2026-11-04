'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Readable } = require('node:stream');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { criarCopiaDeImagens } = require('../../src/services/imagem-backup-copia.service');
const { avaliarConjunto } = require('../../src/services/imagem-backup.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-VERIFICACAO-IMAGENS-COPIADAS-1): VERIFICAÇÃO FÍSICA INDEPENDENTE das imagens JÁ COPIADAS para a preparação. Só dados FICTÍCIOS em diretórios
 * temporários exclusivos (prefixo `gepi-verificacao-test-`). Nada aqui toca PostgreSQL, `pg_dump`, processo real ou imagens reais, e a verificação das imagens NÃO prova integridade do dump, consistência
 * transacional PostgreSQL x filesystem, autenticidade, restauração ou recuperabilidade.
 *
 * CONTRATOS REAIS CONFIRMADOS (CTL-01 a CTL-03 executam):
 *   - plano (`planejarArquivos`): itens { chave, sha256 } em ordem de chave; `chave` = "<empresaId|padrao>/<hashDoDiretorio>/<variante>"; `sha256` = hash esperado do CONTEÚDO da variante. Em imagem de
 *     EMPRESA o hash do DIRETÓRIO (`registro.sha256`) é diferente do hash do conteúdo da mestre (`sha256Mestre`): o verificador deve comparar o conteúdo com o `sha256` do ITEM, nunca com o segmento da chave;
 *   - cópia (`criarCopiaDeImagens`): { ok, completo, arquivos: [{ chave, sha256, bytes }], copiados, falha }; o `sha256` e os `bytes` foram recalculados pelo `gravar` NA GRAVAÇÃO (não há releitura posterior);
 *   - localização física do destino: <raiz do armazenamento>/<chave>; o armazenamento (`abrir(chave)`) valida o formato da chave, confere por `lstat` cada componente (link simbólico ou tipo errado ->
 *     CHAVE_INVALIDA), abre o arquivo final com O_NOFOLLOW e entrega um FLUXO; ausente -> ARQUIVO_AUSENTE. É a única porta de leitura da preparação reutilizada pelo verificador;
 *   - nenhum identificador de operação, snapshot ou conjunto existe nos contratos do plano, da cópia ou do armazenamento (a associação é só: este destino, este plano, esta cópia).
 *
 * INTERFACE MÍNIMA PROPOSTA (provisória; nada em produção): src/services/imagem-backup-verificacao-imagens-copiadas.service.js exporta
 *   `criarVerificadorDeImagensCopiadas({ destino })` (ESTRITO; TypeError se inválido; `destino.abrir` capturado UMA vez, chamado com o `this` original) -> { verificar({ plano, copia }) }:
 *   - o `destino` é o armazenamento da PREPARAÇÃO, fixado pela composição confiável; nenhum caminho é aceito do chamador; só `abrir` é usado (leitura): nunca `gravar`, `remover` ou `existe`;
 *   - `verificar` é ESTRITO (só `plano` e `copia`), SEM estado entre chamadas (reentrante e reutilizável): cada chamada relê os arquivos de verdade e nada positivo é guardado ou reaproveitado;
 *   - antes de qualquer E/S exige entradas consistentes: `plano` = lista de { chave, sha256 } sem chave repetida, chaves no formato do armazenamento (sem travessia), hashes de 64 hex; `copia` completa
 *     (`ok`, `completo`, `falha` nula, `copiados` = tamanho) com itens { chave, sha256, bytes } iguais ao plano em chaves e hashes; qualquer outra coisa é inconclusiva ENTRADA_INVALIDA, sem ler nada;
 *   - para CADA item esperado relê o arquivo físico do destino em fluxo, conta os bytes e calcula o SHA-256 dos bytes realmente lidos, e compara com o `sha256` do plano e os `bytes` da cópia;
 *   - resultados (congelados): { concluida: true, ok: true, examinados, bytes } | { concluida: true, ok: false, examinados, divergencias: [{ chave, codigo }] } com codigo em ARQUIVO_AUSENTE |
 *     ARQUIVO_INVALIDO | TAMANHO_DIVERGENTE | SHA256_DIVERGENTE (uma por arquivo; `examinados` = arquivos cujos bytes foram lidos até o fim) | { concluida: false, ok: false, motivo } com motivo em
 *     ENTRADA_INVALIDA | LEITURA_FALHOU (leitura que não pôde ser concluída, inclusive falha ao fechar o fluxo próprio). Sem eco de caminho, mensagem de exceção ou valor recebido;
 *   - arquivos EXTRAS no destino (fora do plano) NÃO são examinados nem falham a verificação: o armazenamento permite compartilhamento/reutilização de pastas; a igualdade lógica exigida é a do manifesto;
 *   - o resultado tem a forma de `verificacao { concluida, ok }` do avaliador, mas NÃO produz `relatorio.veredito`, `valido`, `recuperavel`, `publicado` nem qualquer campo do dump.
 *
 * COMO LER: o módulo NÃO existe; as falhas por "módulo ausente" NÃO são provas comportamentais independentes. Os CTL-* passam hoje.
 */

const MODULO = 'src/services/imagem-backup-verificacao-imagens-copiadas.service';
const modulo = () => exigirModulo(MODULO);
const PRAZO = 20000;
const PREFIXO = 'gepi-verificacao-test-';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const teste = (nome, fn) => test(nome, { timeout: PRAZO }, fn);
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------------------------------------------------------------------- cenário
const raizes = [];
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of raizes) if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO)) fs.rmSync(p, { recursive: true, force: true });
});

/** Uma imagem padrão (sem exibição) e duas empresas com o MESMO diretório de hash e conteúdos diferentes: 8 arquivos. */
async function cenario() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
  fs.chmodSync(raiz, 0o700);
  raizes.push(raiz);
  const buf = (t) => Buffer.from(t, 'utf8');
  const padraoMestre = buf('padrao-mestre-conteudo');
  const padraoMiniatura = buf('padrao-miniatura-conteudo');
  const linha = (id, empresaId) => ({
    id: String(id), empresaId, sha256: H('c'), formato: 'PNG', sha256Mestre: sha(buf(`mestre-${empresaId}-conteudo`)), sha256Exibicao: sha(buf(`exib-${empresaId}-conteudo`)), sha256Miniatura: sha(buf(`mini-${empresaId}-conteudo`)),
    bytesMestre: buf(`mestre-${empresaId}-conteudo`).length, bytesExibicao: buf(`exib-${empresaId}-conteudo`).length, bytesMiniatura: buf(`mini-${empresaId}-conteudo`).length,
  });
  const conteudos = [padraoMestre, padraoMiniatura, ...[7, 8].flatMap((e) => [buf(`mestre-${e}-conteudo`), buf(`exib-${e}-conteudo`), buf(`mini-${e}-conteudo`)])];
  const registros = {
    padrao: [{ id: '1', sha256: sha(padraoMestre), sha256Miniatura: sha(padraoMiniatura), sha256Exibicao: null, formato: 'PNG', bytesMestre: padraoMestre.length, bytesMiniatura: padraoMiniatura.length, bytesExibicao: null }],
    empresa: [linha(1, 7), linha(2, 8)],
  };
  const plano = planejarArquivos(registros);
  const origem = criarArmazenamentoImagens({ diretorio: path.join(raiz, 'origem') });
  const raizDoDestino = path.join(raiz, 'preparacao', 'imagens');
  const destino = criarArmazenamentoImagens({ diretorio: raizDoDestino });
  for (const item of plano) await origem.gravar(item.chave, conteudos.find((c) => sha(c) === item.sha256), { maxBytes: 4096, sha256Esperado: item.sha256 });
  const contexto = Object.freeze({ plano });
  const copia = await criarCopiaDeImagens({ origem, destino, maxBytesPorArquivo: 4096 })(contexto);
  assert.equal(copia.ok, true);
  const fisico = (chave) => path.join(fs.realpathSync(raizDoDestino), chave);
  return { raiz, plano, copia, destino, fisico, raizDoDestino: fs.realpathSync(raizDoDestino), conteudos };
}
const chaveDe = (c, filtro) => c.plano.find((p) => filtro(p.chave)).chave;
const verificar = (c, { destino = c.destino, plano = c.plano, copia = c.copia } = {}) => modulo().criarVerificadorDeImagensCopiadas({ destino }).verificar({ plano, copia });
const semAfirmacoes = (r) => {
  const t = JSON.stringify(r).toLowerCase();
  for (const proibida of ['veredito', 'valido', 'recuper', 'publicad', 'declarado', 'restaur', 'dump']) assert.equal(t.includes(proibida), false, proibida);
};
const semVazamento = (r) => {
  const t = JSON.stringify(r);
  for (const proibido of [SEGREDO, '/Users/privado', os.tmpdir(), PREFIXO]) assert.equal(t.includes(proibido), false, proibido);
};
const divergencia = (r, chave, codigo) => {
  assert.equal(r.concluida, true);
  assert.equal(r.ok, false);
  assert.deepEqual(r.divergencias.find((d) => d.chave === chave), { chave, codigo });
};
const arvore = (dir) => fs.readdirSync(dir, { recursive: true }).sort().map((n) => { const p = path.join(dir, n); const e = fs.lstatSync(p); return [n, e.isFile() ? sha(fs.readFileSync(p)) : e.isDirectory() ? 'dir' : 'outro']; });

/** Armazenamento duplo (só `abrir`) para falhas de leitura e pendência controladas pelo teste; registra tudo que é chamado. */
function destinoDuplo(abrirPorChave) {
  const registro = { abrir: [], outros: [] };
  const objeto = {
    registro,
    async abrir(chave) { registro.abrir.push(chave); return abrirPorChave(chave); },
    async gravar() { registro.outros.push('gravar'); },
    async remover() { registro.outros.push('remover'); },
    async existe() { registro.outros.push('existe'); },
  };
  return objeto;
}
const fluxoDe = (conteudo, { aoDestruir } = {}) => {
  const f = Readable.from([conteudo]);
  const original = f.destroy.bind(f);
  f.destroy = (...a) => { if (aoDestruir) aoDestruir(); return original(...a); };
  return f;
};

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: os contratos reais sobre os quais o verificador se apoia', () => {
  teste('CTL-01 (VER-01) — plano real + cópia real em diretórios temporários: o hash físico de cada arquivo do DESTINO, recalculado pelo teste, é o do plano; em imagem de EMPRESA o hash do diretório da chave NÃO é o hash do conteúdo da mestre', async () => {
    const c = await cenario();
    assert.equal(c.plano.length, 8);
    for (const item of c.plano) assert.equal(sha(fs.readFileSync(c.fisico(item.chave))), item.sha256);
    const mestre7 = chaveDe(c, (k) => k.startsWith('7/') && k.endsWith('mestre.png'));
    const item = c.plano.find((p) => p.chave === mestre7);
    assert.equal(mestre7.split('/')[1], H('c'));
    assert.notEqual(item.sha256, H('c'));
    assert.equal(sha(fs.readFileSync(c.fisico(mestre7))), item.sha256);
    const copiado = c.copia.arquivos.find((a) => a.chave === mestre7);
    assert.equal(copiado.sha256, item.sha256);
    assert.equal(copiado.bytes, fs.statSync(c.fisico(mestre7)).size);
    assert.equal(c.copia.arquivos.length, c.plano.length);
  });

  teste('CTL-02 — o armazenamento (porta de leitura) rejeita o que o verificador não pode aceitar: ausente (ARQUIVO_AUSENTE), link simbólico no arquivo ou em diretório intermediário, diretório no lugar do arquivo e chave com travessia (CHAVE_INVALIDA)', async () => {
    const c = await cenario();
    const chave = chaveDe(c, (k) => k.startsWith('7/') && k.endsWith('miniatura.webp'));
    const outra = chaveDe(c, (k) => k.startsWith('8/') && k.endsWith('miniatura.webp'));
    await assert.rejects(c.destino.abrir(`9/${H('1')}/mestre.png`), (e) => e.codigo === 'ARQUIVO_AUSENTE');
    fs.rmSync(c.fisico(chave));
    fs.symlinkSync(c.fisico(outra), c.fisico(chave));
    await assert.rejects(c.destino.abrir(chave), (e) => e.codigo === 'CHAVE_INVALIDA');
    fs.rmSync(c.fisico(chave));
    fs.mkdirSync(c.fisico(chave));
    await assert.rejects(c.destino.abrir(chave), (e) => e.codigo === 'CHAVE_INVALIDA');
    await assert.rejects(c.destino.abrir('../fora/mestre.png'), (e) => e.codigo === 'CHAVE_INVALIDA');
    const dir8 = path.join(c.raizDoDestino, '8');
    fs.renameSync(dir8, `${dir8}-original`);
    fs.symlinkSync(`${dir8}-original`, dir8);
    await assert.rejects(c.destino.abrir(outra), (e) => e.codigo === 'CHAVE_INVALIDA');
  });

  teste('CTL-03 (VER-12) — o `avaliarConjunto` real lê `verificacao { concluida, ok }`, mas, sozinha, uma verificação positiva NÃO torna nada válido: faltam saída do procedimento, relatório, dump e identidade (mesmos motivos continuam)', () => {
    const r = avaliarConjunto({ verificacao: { concluida: true, ok: true } });
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
    assert.equal(r.motivos.includes('VERIFICACAO_NAO_CONCLUIDA'), false);
    assert.equal(r.motivos.includes('VERIFICACAO_FALHOU'), false);
    for (const m of ['SAIDA_NAO_ZERO', 'RELATORIO_AUSENTE', 'DUMP_AUSENTE', 'IDENTIDADE_INVALIDA']) assert.ok(r.motivos.includes(m), m);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- VER-02 a VER-05
describe('[VER] verificação física independente dos arquivos de destino', () => {
  teste('VER-02 — conjunto ÍNTEGRO: relê todos os arquivos esperados; { concluida, ok } verdadeiros, `examinados` = 8, `bytes` = soma dos tamanhos físicos; nada além disso, e nada que afirme veredito, validade ou recuperabilidade', async () => {
    const c = await cenario();
    const r = await verificar(c);
    assert.deepEqual(Object.keys(r).sort(), ['bytes', 'concluida', 'examinados', 'ok']);
    assert.equal(r.concluida, true);
    assert.equal(r.ok, true);
    assert.equal(r.examinados, 8);
    assert.equal(r.bytes, c.plano.reduce((s, p) => s + fs.statSync(c.fisico(p.chave)).size, 0));
    assert.equal(Object.isFrozen(r), true);
    semAfirmacoes(r);
  });

  teste('VER-03 — arquivo AUSENTE no destino: nunca sucesso; ARQUIVO_AUSENTE para ele, os outros examinados (7)', async () => {
    const c = await cenario();
    const chave = chaveDe(c, (k) => k.startsWith('padrao/') && k.endsWith('miniatura.webp'));
    fs.rmSync(c.fisico(chave));
    const r = await verificar(c);
    assert.equal(r.ok, false);
    assert.equal(r.examinados, 7);
    assert.equal(r.divergencias.length, 1);
    divergencia(r, chave, 'ARQUIVO_AUSENTE');
    semVazamento(r);
  });

  teste('VER-04 — arquivo ALTERADO: mesmo tamanho com um byte trocado = SHA256_DIVERGENTE; truncado = TAMANHO_DIVERGENTE; acrescentado = TAMANHO_DIVERGENTE; nenhum é íntegro', async () => {
    const c = await cenario();
    const igual = chaveDe(c, (k) => k.startsWith('7/') && k.endsWith('mestre.png'));
    const curto = chaveDe(c, (k) => k.startsWith('8/') && k.endsWith('mestre.png'));
    const longo = chaveDe(c, (k) => k.startsWith('padrao/') && k.endsWith('mestre.png'));
    const fd = fs.openSync(c.fisico(igual), 'r+');
    const primeiro = Buffer.alloc(1);
    fs.readSync(fd, primeiro, 0, 1, 0);
    fs.writeSync(fd, Buffer.from([primeiro[0] ^ 0xff]), 0, 1, 0);
    fs.closeSync(fd);
    fs.truncateSync(c.fisico(curto), fs.statSync(c.fisico(curto)).size - 1);
    fs.appendFileSync(c.fisico(longo), Buffer.from('x'));
    const r = await verificar(c);
    assert.equal(r.ok, false);
    assert.equal(r.examinados, 8);
    assert.equal(r.divergencias.length, 3);
    divergencia(r, igual, 'SHA256_DIVERGENTE');
    divergencia(r, curto, 'TAMANHO_DIVERGENTE');
    divergencia(r, longo, 'TAMANHO_DIVERGENTE');
  });

  teste('VER-05 — VARIANTES: o conteúdo é comparado com o hash do ITEM (sha256Mestre/Exibicao/Miniatura), nunca com o hash do diretório da chave; conteúdo da exibição colocado na mestre da mesma empresa e arquivos trocados entre empresas com o MESMO diretório de hash são divergências', async () => {
    const c = await cenario();
    // o verificador correto aprova o conjunto íntegro mesmo com dir != hash de conteúdo
    assert.equal((await verificar(c)).ok, true);
    const mestre7 = chaveDe(c, (k) => k.startsWith('7/') && k.endsWith('mestre.png'));
    const exib7 = chaveDe(c, (k) => k.startsWith('7/') && k.endsWith('exibicao.webp'));
    const mini7 = chaveDe(c, (k) => k.startsWith('7/') && k.endsWith('miniatura.webp'));
    const mini8 = chaveDe(c, (k) => k.startsWith('8/') && k.endsWith('miniatura.webp'));
    const bytesExib7 = fs.readFileSync(c.fisico(exib7));
    fs.writeFileSync(c.fisico(mestre7), bytesExib7);
    const bytesMini7 = fs.readFileSync(c.fisico(mini7));
    const bytesMini8 = fs.readFileSync(c.fisico(mini8));
    fs.writeFileSync(c.fisico(mini7), bytesMini8);
    fs.writeFileSync(c.fisico(mini8), bytesMini7);
    const r = await verificar(c);
    assert.equal(r.ok, false);
    assert.equal(r.concluida, true);
    for (const chave of [mestre7, mini7, mini8]) assert.ok(r.divergencias.some((d) => d.chave === chave), chave);
    assert.equal(r.divergencias.length, 3);
    for (const d of r.divergencias) assert.ok(['SHA256_DIVERGENTE', 'TAMANHO_DIVERGENTE'].includes(d.codigo));
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- VER-06, VER-07
describe('[VER] identidade, conjunto e consistência das expectativas', () => {
  teste('VER-06 — SEM MISTURA: o mesmo plano verificado contra OUTRO destino (de outra preparação, íntegra por si) é ARQUIVO_AUSENTE em todos; um plano de outra imagem (hash diferente para a mesma chave) é SHA256_DIVERGENTE contra a cópia; nenhuma associação além de "este destino, este plano, esta cópia" é inventada', async () => {
    const a = await cenario();
    // outra preparação, sem os arquivos deste plano (os dados fictícios dos cenários são idênticos, então um segundo cenário completo teria os MESMOS arquivos)
    const outraPreparacao = criarArmazenamentoImagens({ diretorio: path.join(a.raiz, 'outra-preparacao') });
    const noOutro = await verificar(a, { destino: outraPreparacao });
    assert.equal(noOutro.ok, false);
    assert.equal(noOutro.divergencias.length, 8);
    assert.ok(noOutro.divergencias.every((d) => d.codigo === 'ARQUIVO_AUSENTE'));
    assert.equal(noOutro.examinados, 0);
    // as expectativas (plano E cópia) de uma imagem de outro conjunto, mesma chave com outro conteúdo esperado
    const planoAlheio = clone(a.plano);
    const copiaAlheia = clone(a.copia);
    planoAlheio[0].sha256 = H('0');
    copiaAlheia.arquivos[0].sha256 = H('0');
    const r = await verificar(a, { plano: planoAlheio, copia: copiaAlheia });
    assert.equal(r.ok, false);
    divergencia(r, planoAlheio[0].chave, 'SHA256_DIVERGENTE');
  });

  teste('VER-07 — EXTRAS e DUPLICADOS: arquivo extra no destino (fora do plano) NÃO falha nem é examinado; plano com chave repetida, cópia com item repetido, cópia e plano contraditórios (hash ou conjunto de chaves) são ENTRADA_INVALIDA inconclusiva, sem ler nada', async () => {
    const c = await cenario();
    const extra = `9/${H('1')}/mestre.png`;
    await c.destino.gravar(extra, Buffer.from('extra-fora-do-plano'), { maxBytes: 100 });
    const comExtra = await verificar(c);
    assert.equal(comExtra.ok, true);
    assert.equal(comExtra.examinados, 8);

    const ruins = [
      ['plano com chave repetida', { plano: [...clone(c.plano), clone(c.plano[0])] }],
      ['cópia com item repetido', { copia: { ...clone(c.copia), arquivos: [...clone(c.copia.arquivos), clone(c.copia.arquivos[0])], copiados: 9 } }],
      ['hash do plano diferente do da cópia', { plano: clone(c.plano).map((p, i) => (i === 0 ? { ...p, sha256: H('0') } : p)) }],
      ['plano com chave que a cópia não tem', { plano: [...clone(c.plano), { chave: `9/${H('2')}/mestre.png`, sha256: H('2') }] }],
      ['cópia com chave que o plano não tem', { copia: { ...clone(c.copia), arquivos: [...clone(c.copia.arquivos), { chave: `9/${H('2')}/mestre.png`, sha256: H('2'), bytes: 1 }], copiados: 9 } }],
    ];
    for (const [rotulo, troca] of ruins) {
      const duplo = destinoDuplo(() => { throw new Error('não deveria ler'); });
      const r = await modulo().criarVerificadorDeImagensCopiadas({ destino: duplo }).verificar({ plano: c.plano, copia: c.copia, ...troca });
      assert.deepEqual({ concluida: r.concluida, ok: r.ok, motivo: r.motivo }, { concluida: false, ok: false, motivo: 'ENTRADA_INVALIDA' }, rotulo);
      assert.deepEqual(duplo.registro.abrir, [], `${rotulo}: nenhuma leitura`);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- VER-08
describe('[VER] caminhos e links', () => {
  teste('VER-08a — link simbólico no lugar do arquivo (apontando para conteúdo IDÊNTICO), diretório no lugar do arquivo e link simbólico em diretório intermediário: ARQUIVO_INVALIDO, nunca íntegro', async () => {
    const c = await cenario();
    const comLink = chaveDe(c, (k) => k.startsWith('7/') && k.endsWith('mestre.png'));
    const comDiretorio = chaveDe(c, (k) => k.startsWith('7/') && k.endsWith('miniatura.webp'));
    const idêntico = path.join(c.raiz, 'copia-identica');
    fs.writeFileSync(idêntico, fs.readFileSync(c.fisico(comLink)));
    fs.rmSync(c.fisico(comLink));
    fs.symlinkSync(idêntico, c.fisico(comLink));
    fs.rmSync(c.fisico(comDiretorio));
    fs.mkdirSync(c.fisico(comDiretorio));
    const dir8 = path.join(c.raizDoDestino, '8');
    fs.renameSync(dir8, `${dir8}-original`);
    fs.symlinkSync(`${dir8}-original`, dir8);
    const r = await verificar(c);
    assert.equal(r.ok, false);
    divergencia(r, comLink, 'ARQUIVO_INVALIDO');
    divergencia(r, comDiretorio, 'ARQUIVO_INVALIDO');
    for (const item of c.plano.filter((p) => p.chave.startsWith('8/'))) divergencia(r, item.chave, 'ARQUIVO_INVALIDO');
    assert.equal(r.divergencias.length, 5);
  });

  teste('VER-08b — chaves com travessia, absolutas, vazias ou fora do formato no plano/cópia: ENTRADA_INVALIDA ANTES de qualquer leitura (o armazenamento nem é chamado); o verificador não aceita caminhos como autoridade de leitura', async () => {
    const c = await cenario();
    for (const chave of ['../fora/mestre.png', `/etc/${H('a')}/mestre.png`, '', 'padrao/../x', `padrao/${H('a')}/../../../x.png`, `padrao/${H('a')}/mestre.png/`, 'C:\\x']) {
      const duplo = destinoDuplo(() => { throw new Error('não deveria ler'); });
      const plano = [{ chave, sha256: H('a') }];
      const copia = { ok: true, completo: true, falha: null, copiados: 1, arquivos: [{ chave, sha256: H('a'), bytes: 1 }] };
      const r = await modulo().criarVerificadorDeImagensCopiadas({ destino: duplo }).verificar({ plano, copia });
      assert.deepEqual({ concluida: r.concluida, ok: r.ok, motivo: r.motivo }, { concluida: false, ok: false, motivo: 'ENTRADA_INVALIDA' });
      assert.deepEqual(duplo.registro.abrir, []);
      semVazamento(r);
    }
  });

  teste('VER-08c — o verificador é ESTRITO: criação e chamada recusam chaves desconhecidas (como `caminho`/`diretorio`), destino sem `abrir` e entradas que não sejam objetos', async () => {
    const c = await cenario();
    const { criarVerificadorDeImagensCopiadas } = modulo();
    for (const ruim of [null, 'x', [], {}, { destino: {} }, { destino: { abrir: 'x' } }, { destino: c.destino, diretorio: '/tmp' }]) assert.throws(() => criarVerificadorDeImagensCopiadas(ruim), TypeError);
    const v = criarVerificadorDeImagensCopiadas({ destino: c.destino });
    for (const ruim of [null, 'x', [], { plano: c.plano }, { copia: c.copia }, { plano: c.plano, copia: c.copia, destino: c.destino }, { plano: c.plano, copia: c.copia, caminho: '/tmp' }]) {
      const r = await v.verificar(ruim);
      assert.deepEqual({ concluida: r.concluida, ok: r.ok, motivo: r.motivo }, { concluida: false, ok: false, motivo: 'ENTRADA_INVALIDA' });
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- VER-09
describe('[VER] leitura incompleta nunca é íntegra', () => {
  const montar = async () => {
    const c = await cenario();
    const conteudos = new Map(c.plano.map((p) => [p.chave, fs.readFileSync(c.fisico(p.chave))]));
    return { c, conteudos };
  };
  const verificarComDuplo = (c, duplo) => modulo().criarVerificadorDeImagensCopiadas({ destino: duplo }).verificar({ plano: c.plano, copia: c.copia });

  teste('VER-09a — `abrir` que rejeita com mensagem hostil, fluxo que falha NO MEIO da leitura e retorno que não é fluxo: concluida:false/LEITURA_FALHOU, nunca ok:true, sem vazar a mensagem', async () => {
    const { c, conteudos } = await montar();
    const alvo = c.plano[2].chave;
    for (const falhar of [
      () => { throw new TypeError(`${SEGREDO} /Users/privado`); },
      () => new Readable({ read() { this.push(conteudos.get(alvo).subarray(0, 3)); this.destroy(new Error(`${SEGREDO} /Users/privado`)); } }),
      () => ({}),
      () => null,
    ]) {
      const duplo = destinoDuplo((chave) => (chave === alvo ? falhar() : fluxoDe(conteudos.get(chave))));
      const r = await verificarComDuplo(c, duplo);
      assert.equal(r.ok, false);
      assert.equal(r.concluida, false);
      assert.equal(r.motivo, 'LEITURA_FALHOU');
      semVazamento(r);
      semAfirmacoes(r);
    }
  });

  teste('VER-09b — fluxo que ACABA ANTES do tempo (leitura parcial sem erro) é TAMANHO_DIVERGENTE: bytes lidos < esperados nunca é íntegro', async () => {
    const { c, conteudos } = await montar();
    const alvo = c.plano[0].chave;
    const duplo = destinoDuplo((chave) => fluxoDe(chave === alvo ? conteudos.get(chave).subarray(0, 4) : conteudos.get(chave)));
    const r = await verificarComDuplo(c, duplo);
    assert.equal(r.ok, false);
    divergencia(r, alvo, 'TAMANHO_DIVERGENTE');
  });

  teste('VER-09c — FECHAMENTO: o fluxo próprio é destruído depois de lido (íntegro ou não); falha ao destruir é LEITURA_FALHOU conservador (concluida:false), nunca ok:true', async () => {
    const { c, conteudos } = await montar();
    let destruidos = 0;
    const normal = destinoDuplo((chave) => fluxoDe(conteudos.get(chave), { aoDestruir: () => { destruidos += 1; } }));
    const ok = await verificarComDuplo(c, normal);
    assert.equal(ok.ok, true);
    assert.equal(destruidos, c.plano.length, 'todo fluxo aberto foi fechado pelo verificador');

    const alvo = c.plano[1].chave;
    // Double mínimo (iterável assíncrono + destroy), SEM o autoDestroy interno de um Readable real: o único chamador de `destroy` é o próprio verificador.
    const registro = { chamadas: 0 };
    const fluxoQueFalhaAoDestruir = (conteudo) => ({
      destroyed: false,
      async *[Symbol.asyncIterator]() { yield conteudo; },
      destroy() { registro.chamadas += 1; throw new TypeError(`${SEGREDO} /Users/privado`); },
    });
    const comFalha = destinoDuplo((chave) => (chave === alvo ? fluxoQueFalhaAoDestruir(conteudos.get(chave)) : fluxoDe(conteudos.get(chave))));
    const r = await verificarComDuplo(c, comFalha);
    assert.equal(registro.chamadas, 1, 'o verificador chamou `destroy` do fluxo próprio exatamente uma vez');
    assert.equal(r.ok, false);
    assert.equal(r.concluida, false);
    assert.equal(r.motivo, 'LEITURA_FALHOU');
    semVazamento(r);
    semAfirmacoes(r);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- VER-10
describe('[VER] estado, reutilização e concorrência (verificador sem estado: nada positivo é guardado)', () => {
  teste('VER-10a — REUTILIZÁVEL: cada chamada relê de verdade. Íntegro -> ok; um arquivo é alterado -> a MESMA instância detecta (nenhum positivo antigo é reaproveitado); restaurado -> ok de novo; resultados são objetos distintos', async () => {
    const c = await cenario();
    const v = modulo().criarVerificadorDeImagensCopiadas({ destino: c.destino });
    const chave = chaveDe(c, (k) => k.startsWith('7/') && k.endsWith('mestre.png'));
    const original = fs.readFileSync(c.fisico(chave));
    const r1 = await v.verificar({ plano: c.plano, copia: c.copia });
    assert.equal(r1.ok, true);
    fs.appendFileSync(c.fisico(chave), Buffer.from('depois'));
    const r2 = await v.verificar({ plano: c.plano, copia: c.copia });
    assert.equal(r2.ok, false);
    divergencia(r2, chave, 'TAMANHO_DIVERGENTE');
    fs.writeFileSync(c.fisico(chave), original);
    const r3 = await v.verificar({ plano: c.plano, copia: c.copia });
    assert.equal(r3.ok, true);
    assert.notEqual(r1, r3);
    assert.equal(r1.ok, true, 'o resultado anterior não foi alterado');
  });

  teste('VER-10b — CONCORRENTE e sem mistura: verificações simultâneas na mesma instância e em instâncias diferentes dão cada uma o resultado do SEU conjunto (A íntegro, B adulterado), sem contaminação', async () => {
    const a = await cenario();
    const b = await cenario();
    const chaveB = chaveDe(b, (k) => k.startsWith('8/') && k.endsWith('exibicao.webp'));
    const tamanhoOriginal = fs.statSync(b.fisico(chaveB)).size;
    const adulterado = Buffer.alloc(tamanhoOriginal, 0x78); // mesmo tamanho, bytes diferentes: o que muda é só o SHA-256
    assert.notEqual(sha(adulterado), sha(fs.readFileSync(b.fisico(chaveB))));
    fs.writeFileSync(b.fisico(chaveB), adulterado);
    assert.equal(fs.statSync(b.fisico(chaveB)).size, tamanhoOriginal);
    const va = modulo().criarVerificadorDeImagensCopiadas({ destino: a.destino });
    const vb = modulo().criarVerificadorDeImagensCopiadas({ destino: b.destino });
    const [ra1, rb1, ra2, rb2] = await Promise.all([va.verificar({ plano: a.plano, copia: a.copia }), vb.verificar({ plano: b.plano, copia: b.copia }), va.verificar({ plano: a.plano, copia: a.copia }), vb.verificar({ plano: b.plano, copia: b.copia })]);
    assert.equal(ra1.ok, true);
    assert.equal(ra2.ok, true);
    assert.equal(rb1.ok, false);
    assert.equal(rb2.ok, false);
    divergencia(rb1, chaveB, 'SHA256_DIVERGENTE');
    divergencia(rb2, chaveB, 'SHA256_DIVERGENTE');
  });

  teste('VER-10c — PENDENTE: enquanto a leitura de um arquivo não termina (barreira controlada pelo teste), a verificação NÃO resolve nem produz positivo parcial; liberada a barreira, conclui corretamente com TODOS os arquivos', async () => {
    const c = await cenario();
    const conteudos = new Map(c.plano.map((p) => [p.chave, fs.readFileSync(c.fisico(p.chave))]));
    const alvo = c.plano[3].chave;
    let liberarFim;
    let leituraComecou;
    const comecou = new Promise((res) => { leituraComecou = res; });
    const fim = new Promise((res) => { liberarFim = res; });
    const duplo = destinoDuplo((chave) => {
      if (chave !== alvo) return fluxoDe(conteudos.get(chave));
      const bytes = conteudos.get(chave);
      let enviou = false;
      return new Readable({
        read() {
          if (!enviou) { enviou = true; this.push(bytes.subarray(0, 2)); leituraComecou(); return; }
          fim.then(() => { this.push(bytes.subarray(2)); this.push(null); });
        },
      });
    });
    let resolvida = false;
    const promessa = modulo().criarVerificadorDeImagensCopiadas({ destino: duplo }).verificar({ plano: c.plano, copia: c.copia }).then((r) => { resolvida = true; return r; });
    await comecou;
    assert.equal(resolvida, false, 'sem resultado enquanto a leitura está pendente');
    liberarFim();
    const r = await promessa;
    assert.equal(r.ok, true);
    assert.equal(r.examinados, c.plano.length);
    assert.equal(duplo.registro.abrir.length, c.plano.length, 'cada arquivo foi aberto uma vez');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- VER-11, VER-12
describe('[VER] ordem, efeitos colaterais e limites', () => {
  teste('VER-11a — ORDEM: sem cópia concluída e íntegra (ok falso, incompleta, falha presente, `copiados` incoerente) a verificação não lê nada e é ENTRADA_INVALIDA; nunca sucesso', async () => {
    const c = await cenario();
    const copias = [
      { ...clone(c.copia), ok: false },
      { ...clone(c.copia), completo: false },
      { ...clone(c.copia), falha: { codigo: 'COPIA_FALHOU', chave: null } },
      { ...clone(c.copia), copiados: 3 },
      { ok: false, completo: false, arquivos: [], copiados: 0, falha: { codigo: 'ORIGEM_AUSENTE', chave: c.plano[0].chave } },
    ];
    for (const copia of copias) {
      const duplo = destinoDuplo(() => { throw new Error('não deveria ler'); });
      const r = await modulo().criarVerificadorDeImagensCopiadas({ destino: duplo }).verificar({ plano: c.plano, copia });
      assert.deepEqual({ concluida: r.concluida, ok: r.ok, motivo: r.motivo }, { concluida: false, ok: false, motivo: 'ENTRADA_INVALIDA' });
      assert.deepEqual(duplo.registro.abrir, []);
    }
  });

  teste('VER-11b — SEM EFEITOS: só `abrir` é usado (nunca gravar, remover ou existe); os arquivos do destino ficam idênticos (árvore e hashes) mesmo com divergências; o verificador não tem como copiar, selar, publicar, finalizar snapshot ou liberar trava', async () => {
    const c = await cenario();
    fs.writeFileSync(c.fisico(c.plano[0].chave), Buffer.from('divergente'));
    const conteudos = new Map(c.plano.map((p) => [p.chave, fs.readFileSync(c.fisico(p.chave))]));
    const duplo = destinoDuplo((chave) => fluxoDe(conteudos.get(chave)));
    const antes = arvore(c.raizDoDestino);
    const v = modulo().criarVerificadorDeImagensCopiadas({ destino: duplo });
    const r = await v.verificar({ plano: c.plano, copia: c.copia });
    assert.equal(r.ok, false);
    assert.deepEqual(duplo.registro.outros, []);
    assert.deepEqual([...new Set(duplo.registro.abrir)].sort(), c.plano.map((p) => p.chave).sort());
    assert.deepEqual(arvore(c.raizDoDestino), antes);
    assert.deepEqual(Object.keys(v), ['verificar']);
    for (const nome of ['copiar', 'selar', 'publicar', 'finalizar', 'liberar', 'avaliar']) assert.equal(Object.hasOwn(v, nome), false, nome);
  });

  teste('VER-12 — LIMITES: nenhum resultado (íntegro, divergente ou inconclusivo) traz veredito, `valido`, `recuperavel`, `publicado`, hash declarado ou campo do dump; e alimentar o avaliador real SÓ com esse resultado continua inválido por todas as outras evidências ausentes', async () => {
    const c = await cenario();
    fs.rmSync(c.fisico(c.plano[0].chave));
    const resultados = [await verificar(await cenario()), await verificar(c), await verificar(c, { plano: [] })];
    for (const r of resultados) { semAfirmacoes(r); semVazamento(r); }
    const integra = resultados[0];
    const avaliacao = avaliarConjunto({ verificacao: { concluida: integra.concluida, ok: integra.ok } });
    assert.equal(avaliacao.valido, false);
    assert.equal(avaliacao.recuperavel, false);
    assert.ok(avaliacao.motivos.includes('DUMP_AUSENTE'));
    assert.ok(avaliacao.motivos.includes('RELATORIO_AUSENTE'));
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- pendências
describe('[PENDÊNCIAS] riscos NÃO cobertos por estes testes (registrados)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('VER-13 — TOCTOU: troca do arquivo ou de diretório intermediário ENTRE a conferência por `lstat` do armazenamento e a abertura, ou alteração dos bytes DURANTE a leitura: sem `openat` e sem seam determinístico no armazenamento; `lstat`/`O_NOFOLLOW` reduzem, não eliminam', 'limite da plataforma');
  todo('VER-14 — reescrita de MESMO tamanho com os mesmos metadados não é detectada por tamanho/mtime/ctime; aqui só o SHA-256 relido pega alteração de conteúdo, e nada garante imutabilidade DEPOIS da leitura', 'limite da plataforma');
  todo('VER-15 — política de arquivos EXTRAS no destino (reportar sem falhar? falhar?): decisão de produto; hoje ignorados por contrato', 'decisão pendente');
  todo('VER-16 — verificação pendente indefinidamente (fluxo que nunca termina) exige cancelamento seguro; sem prazo arbitrário aqui; e vazamento de descritores do armazenamento real (contagem antes/depois)', 'incremento próprio');
  todo('VER-17 — consistência transacional entre PostgreSQL (snapshot) e filesystem, integridade física do dump, autenticidade do conjunto, restauração independente: fora do alcance desta verificação', 'bloqueio operacional');
});
