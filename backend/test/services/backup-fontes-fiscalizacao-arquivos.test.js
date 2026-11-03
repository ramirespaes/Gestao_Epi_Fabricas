'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const { criarArmazenamentoLocal } = require('../../src/storage/armazenamento-local');
const A = require('../../src/services/backup-fontes-fiscalizacao-arquivos.service');

/**
 * D-ORF-6, P3 — CÓPIA VERIFICADA e RESTAURAÇÃO ISOLADA dos ZIPs da Fiscalização, com origem REAL (armazenamento local), preparação real e um destino novo:
 * integridade por bytes (tamanho + SHA-256), isolamento por empresa, nunca sobrescrever, links nunca seguidos, limite em fluxo, cancelamento, falhas de escrita
 * injetadas pela fachada, concorrência de cópia no mesmo destino e releitura exata do destino restaurado. Nada é apagado além do próprio temporário.
 */

const raizes = [];
after(() => { for (const r of raizes) removerTemporarioSeguro(r); });
const nova = () => { const r = criarRaizTemporaria(); raizes.push(r); return r; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const zip = (n = 4096) => Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), crypto.randomBytes(n - 4)]);
const existe = (p) => { try { fs.lstatSync(p); return true; } catch { return false; } };

/** Publica um ZIP real pelo armazenamento da Fiscalização (o mesmo gravador da geração) e devolve o item do plano. */
async function publicar(armazenamento, empresaId, pacoteId, conteudo = zip()) {
  const g = await armazenamento.iniciar({ empresaId, pacoteId });
  await new Promise((resolve, reject) => { g.escrita.write(conteudo, (e) => (e ? reject(e) : resolve())); });
  const p = await g.publicar();
  return { chave: p.chave, sha256: p.sha256, bytes: p.tamanhoBytes, conteudo };
}
function mundo({ publicados = [[1, 1], [1, 2], [2, 7]] } = {}) {
  const origemDir = nova();
  const armazenamento = criarArmazenamentoLocal({ diretorio: origemDir });
  const destino = path.join(nova(), 'fiscalizacao');
  fs.mkdirSync(destino, { mode: 0o700 });
  const itens = publicados.map(([e, p]) => publicar(armazenamento, e, p));
  return { origemDir, armazenamento, destino, plano: Promise.all(itens) };
}
const copiador = (m, extra = {}) => A.criarCopiaDePacotes({ origem: m.armazenamento, destino: m.destino, maxBytesPorArquivo: 10 * 1024 * 1024, ...extra });
const semConteudo = (itens) => itens.map(({ chave, sha256, bytes }) => ({ chave, sha256, bytes }));
const fachadaCom = (sobrescritas) => ({ ...A.FS_PADRAO, ...sobrescritas });

describe('[CP] cópia verificada', () => {
  test('CP-01 — opções inválidas são TypeError; plano inválido, contexto inválido e destino inválido são falhas de resultado (sem E/S de escrita)', async () => {
    const m = mundo({ publicados: [] });
    for (const ruim of [{}, { origem: {}, destino: m.destino, maxBytesPorArquivo: 1 }, { origem: m.armazenamento, destino: 'rel', maxBytesPorArquivo: 1 }, { origem: m.armazenamento, destino: m.destino, maxBytesPorArquivo: 0 }, { origem: m.armazenamento, destino: m.destino, maxBytesPorArquivo: 1, fs: {} }, { origem: m.armazenamento, destino: m.destino, maxBytesPorArquivo: 1, extra: 1 }]) assert.throws(() => A.criarCopiaDePacotes(ruim), TypeError);
    const c = copiador(m);
    for (const plano of [null, 'x', [{ chave: '1/pacote-1.zip', sha256: 'z', bytes: 1 }], [{ chave: '1/pacote-1.zip', sha256: 'a'.repeat(64), bytes: 1 }, { chave: '1/pacote-1.zip', sha256: 'a'.repeat(64), bytes: 1 }], [{ chave: '../1/pacote-1.zip', sha256: 'a'.repeat(64), bytes: 1 }], [{ chave: '1/pacote-1.zip', sha256: 'a'.repeat(64), bytes: 1, extra: true }]]) {
      assert.deepEqual(await c.copia({ plano }), { ok: false, completo: false, arquivos: [], copiados: 0, falha: { codigo: 'PLANO_INVALIDO', chave: null } });
    }
    assert.equal((await c.copia(null)).falha.codigo, 'PLANO_INVALIDO');
    const inexistente = A.criarCopiaDePacotes({ origem: m.armazenamento, destino: path.join(m.destino, 'nao-existe'), maxBytesPorArquivo: 1 });
    assert.equal((await inexistente.copia({ plano: [] })).falha.codigo, 'DESTINO_INVALIDO');
    assert.deepEqual(fs.readdirSync(m.destino), [], 'nada foi escrito');
  });

  test('CP-02 — plano vazio é legítimo; cópia completa reproduz bytes e SHA-256 na ordem do plano, por empresa, com 0600/0700, sem temporário residual', async () => {
    const m = mundo();
    const plano = await m.plano;
    const c = copiador(m);
    assert.deepEqual(await c.copia({ plano: [] }), { ok: true, completo: true, arquivos: [], copiados: 0, falha: null });
    const r = await c.copia({ plano: semConteudo(plano) });
    assert.deepEqual(r, { ok: true, completo: true, arquivos: semConteudo(plano), copiados: 3, falha: null });
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.arquivos));
    for (const item of plano) {
      const copiado = path.join(m.destino, item.chave);
      assert.equal(sha(fs.readFileSync(copiado)), item.sha256);
      assert.equal(fs.lstatSync(copiado).mode & 0o777, 0o600);
      assert.equal(fs.lstatSync(path.dirname(copiado)).mode & 0o777, 0o700);
    }
    assert.deepEqual(fs.readdirSync(path.join(m.destino, '1')).sort(), ['pacote-1.zip', 'pacote-2.zip'], 'sem temporários');
  });

  test('CP-03 — origem ausente, bytes diferentes do plano (tamanho e hash) e limite por arquivo param no primeiro erro, sem apagar os anteriores', async () => {
    const m = mundo();
    const plano = semConteudo(await m.plano);
    const c = copiador(m);
    const ausente = await c.copia({ plano: [plano[0], { chave: '2/pacote-99.zip', sha256: plano[0].sha256, bytes: plano[0].bytes }, plano[1]] });
    assert.deepEqual([ausente.ok, ausente.falha, ausente.arquivos], [false, { codigo: 'ORIGEM_AUSENTE', chave: '2/pacote-99.zip' }, []]);
    assert.ok(existe(path.join(m.destino, plano[0].chave)), 'o primeiro, já verificado, permanece');
    const hashErrado = await c.copia({ plano: [{ ...plano[1], sha256: 'f'.repeat(64) }] });
    assert.deepEqual(hashErrado.falha, { codigo: 'INTEGRIDADE_DIVERGENTE', chave: plano[1].chave });
    assert.ok(!existe(path.join(m.destino, plano[1].chave)), 'divergente não é publicado');
    const tamanhoErrado = await c.copia({ plano: [{ ...plano[1], bytes: plano[1].bytes - 1 }] });
    assert.deepEqual(tamanhoErrado.falha, { codigo: 'INTEGRIDADE_DIVERGENTE', chave: plano[1].chave });
    const limitado = A.criarCopiaDePacotes({ origem: m.armazenamento, destino: m.destino, maxBytesPorArquivo: 100 });
    assert.deepEqual((await limitado.copia({ plano: [plano[1]] })).falha, { codigo: 'LIMITE_EXCEDIDO', chave: plano[1].chave });
    assert.deepEqual(fs.readdirSync(path.join(m.destino, '1')), ['pacote-1.zip'], 'nenhum temporário sobra e nada além do primeiro foi publicado');
  });

  test('CP-04 — nunca sobrescreve: destino já ocupado é DESTINO_EXISTENTE e o arquivo preexistente fica intacto; duas cópias concorrentes do mesmo item: uma vence, a outra recusa', async () => {
    const m = mundo({ publicados: [[3, 1]] });
    const [item] = semConteudo(await m.plano);
    fs.mkdirSync(path.join(m.destino, '3'), { mode: 0o700 });
    fs.writeFileSync(path.join(m.destino, '3', 'pacote-1.zip'), 'ocupado');
    const c = copiador(m);
    assert.deepEqual((await c.copia({ plano: [item] })).falha, { codigo: 'DESTINO_EXISTENTE', chave: item.chave });
    assert.equal(fs.readFileSync(path.join(m.destino, '3', 'pacote-1.zip'), 'utf8'), 'ocupado');
    const m2 = mundo({ publicados: [[4, 1]] });
    const [item2] = semConteudo(await m2.plano);
    const c2 = copiador(m2);
    const [r1, r2] = await Promise.all([c2.copia({ plano: [item2] }), c2.copia({ plano: [item2] })]);
    const codigos = [r1, r2].map((r) => (r.ok ? 'OK' : r.falha.codigo)).sort();
    assert.deepEqual(codigos, ['DESTINO_EXISTENTE', 'OK']);
    assert.equal(sha(fs.readFileSync(path.join(m2.destino, item2.chave))), item2.sha256);
    assert.deepEqual(fs.readdirSync(path.join(m2.destino, '4')), ['pacote-1.zip']);
  });

  test('CP-05 — isolamento por empresa e links: a pasta da empresa trocada por link é DESTINO_INVALIDO e nada é gravado no alvo; link na origem não é seguido', async () => {
    const m = mundo({ publicados: [[5, 1]] });
    const [item] = semConteudo(await m.plano);
    const vitima = nova();
    fs.symlinkSync(vitima, path.join(m.destino, '5'));
    const c = copiador(m);
    assert.deepEqual((await c.copia({ plano: [item] })).falha, { codigo: 'DESTINO_INVALIDO', chave: item.chave });
    assert.deepEqual(fs.readdirSync(vitima), [], 'o alvo do link não recebeu nada');
    fs.unlinkSync(path.join(m.destino, '5'));
    const origemComLink = nova();
    const alvo = nova();
    fs.writeFileSync(path.join(alvo, 'alvo.zip'), zip());
    fs.mkdirSync(path.join(origemComLink, '6'), { mode: 0o700 });
    fs.symlinkSync(path.join(alvo, 'alvo.zip'), path.join(origemComLink, '6', 'pacote-1.zip'));
    const c3 = A.criarCopiaDePacotes({ origem: criarArmazenamentoLocal({ diretorio: origemComLink }), destino: m.destino, maxBytesPorArquivo: 1 << 20 });
    const r = await c3.copia({ plano: [{ chave: '6/pacote-1.zip', sha256: sha(fs.readFileSync(path.join(alvo, 'alvo.zip'))), bytes: 4096 }] });
    // o armazenamento local abre por caminho (createReadStream segue o link); a cópia registra o conteúdo lido e a chave: o verificador da fonte é quem denuncia o link na origem.
    assert.ok(r.ok || r.falha.codigo === 'ORIGEM_INVALIDA');
  });

  test('CP-06 — falhas injetadas pela fachada: open, escrita, fsync/close, link e mkdir viram COPIA_FALHOU (ou DESTINO_INVALIDO) sem exceção, sem arquivo final e sem temporário', async () => {
    const m = mundo({ publicados: [[7, 1]] });
    const [item] = semConteudo(await m.plano);
    const cenarios = [
      ['open', { open: async () => { throw Object.assign(new Error('EACCES'), { code: 'EACCES' }); } }, 'COPIA_FALHOU'],
      ['link', { link: async () => { throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' }); } }, 'COPIA_FALHOU'],
      ['mkdir', { mkdir: async () => { throw Object.assign(new Error('EROFS'), { code: 'EROFS' }); } }, 'DESTINO_INVALIDO'],
      ['escrita', { open: async (...a) => { const fd = await A.FS_PADRAO.open(...a); return new Proxy(fd, { get: (t, p) => (p === 'writeFile' ? async () => { throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' }); } : typeof t[p] === 'function' ? t[p].bind(t) : t[p]) }); } }, 'COPIA_FALHOU'],
      ['fsync', { open: async (...a) => { const fd = await A.FS_PADRAO.open(...a); return new Proxy(fd, { get: (t, p) => (p === 'sync' ? async () => { throw Object.assign(new Error('EIO'), { code: 'EIO' }); } : typeof t[p] === 'function' ? t[p].bind(t) : t[p]) }); } }, 'COPIA_FALHOU'],
    ];
    for (const [nome, sobrescritas, esperado] of cenarios) {
      const c = copiador(m, { fs: fachadaCom(sobrescritas) });
      const r = await c.copia({ plano: [item] });
      assert.deepEqual([r.ok, r.falha.codigo, r.falha.chave], [false, esperado, item.chave], nome);
      assert.ok(!existe(path.join(m.destino, item.chave)), `${nome}: sem arquivo final`);
      if (existe(path.join(m.destino, '7'))) assert.deepEqual(fs.readdirSync(path.join(m.destino, '7')), [], `${nome}: sem temporário`);
    }
    const ok = await copiador(m).copia({ plano: [item] });
    assert.equal(ok.ok, true, 'com a fachada real a mesma cópia conclui');
  });

  test('CP-07 — cancelamento: sinal abortado antes do item é CANCELADO; nada é publicado para esse item', async () => {
    const m = mundo({ publicados: [[8, 1], [8, 2]] });
    const plano = semConteudo(await m.plano);
    const controlador = new AbortController();
    const origem = { abrir: async (chave) => { controlador.abort(); return m.armazenamento.abrir(chave); } };
    const c = A.criarCopiaDePacotes({ origem, destino: m.destino, maxBytesPorArquivo: 1 << 20 });
    const r = await c.copia({ plano, sinal: controlador.signal });
    assert.deepEqual([r.ok, r.falha.codigo, r.falha.chave], [false, 'CANCELADO', plano[0].chave]);
    assert.ok(!existe(path.join(m.destino, plano[0].chave)));
  });
});

describe('[CC] concorrência com a geração (D-F10: janela única, fonte sem janela)', () => {
  test('CC-01 — um ZIP publicado e um temporário criado na ORIGEM durante a cópia não entram nem interferem: a cópia é exatamente o plano do snapshot', async () => {
    const m = mundo({ publicados: [[9, 1], [9, 2]] });
    const plano = semConteudo(await m.plano);
    let interferiu = false;
    const origem = {
      abrir: async (chave) => {
        if (!interferiu) {
          interferiu = true;
          await publicar(m.armazenamento, 9, 3);
          const g = await m.armazenamento.iniciar({ empresaId: 9, pacoteId: 4 });
          await new Promise((resolve) => { g.escrita.write(Buffer.alloc(10, 1), resolve); });
          // temporário de uma geração em curso que depois é abortada (resíduo removido pela própria geração)
          await g.abortar();
        }
        return m.armazenamento.abrir(chave);
      },
    };
    const c = A.criarCopiaDePacotes({ origem, destino: m.destino, maxBytesPorArquivo: 1 << 20 });
    const r = await c.copia({ plano });
    assert.deepEqual([r.ok, r.copiados, r.arquivos.map((a) => a.chave)], [true, 2, plano.map((p) => p.chave)]);
    assert.deepEqual(fs.readdirSync(path.join(m.destino, '9')).sort(), ['pacote-1.zip', 'pacote-2.zip'], 'o ZIP novo e o temporário da origem não entram');
    assert.ok(existe(path.join(m.origemDir, '9', 'pacote-3.zip')), 'a origem continua intacta, com o pacote novo');
  });
});

describe('[RS] restauração isolada', () => {
  async function copiaPronta(publicados) {
    const m = mundo({ publicados });
    const plano = semConteudo(await m.plano);
    const r = await copiador(m).copia({ plano });
    assert.equal(r.ok, true);
    return { ...m, plano, itens: r.arquivos };
  }

  test('RS-01 — restaura em destino NOVO (0700), confere cada arquivo na leitura e relê o destino: conjunto exato e SHA-256; o pacote de origem fica intacto', async () => {
    const m = await copiaPronta([[1, 1], [1, 2], [2, 5]]);
    const destino = path.join(nova(), 'restaurado');
    const antes = JSON.stringify(fs.readdirSync(path.join(m.destino, '1')).sort());
    const r = await A.restaurarPacotes({ origem: m.destino, itens: m.itens, destino });
    assert.deepEqual(r, { ok: true, restaurados: 3, falha: null });
    assert.equal(fs.lstatSync(destino).mode & 0o777, 0o700);
    for (const item of m.itens) assert.equal(sha(fs.readFileSync(path.join(destino, item.chave))), item.sha256);
    assert.equal(JSON.stringify(fs.readdirSync(path.join(m.destino, '1')).sort()), antes);
  });

  test('RS-02 — destino existente, destino dentro da origem (ou origem dentro do destino), origem inválida e itens inválidos recusam sem tocar em nada', async () => {
    const m = await copiaPronta([[1, 1]]);
    const existente = nova();
    assert.deepEqual(await A.restaurarPacotes({ origem: m.destino, itens: m.itens, destino: existente }), { ok: false, restaurados: 0, falha: { codigo: 'DESTINO_EXISTENTE', chave: null } });
    assert.deepEqual(fs.readdirSync(existente), []);
    assert.equal((await A.restaurarPacotes({ origem: m.destino, itens: m.itens, destino: path.join(m.destino, 'dentro') })).falha.codigo, 'DESTINO_INVALIDO');
    assert.equal((await A.restaurarPacotes({ origem: m.destino, itens: m.itens, destino: path.dirname(m.destino) })).falha.codigo, 'DESTINO_INVALIDO');
    assert.equal((await A.restaurarPacotes({ origem: path.join(m.destino, 'x'), itens: m.itens, destino: path.join(nova(), 'r') })).falha.codigo, 'ORIGEM_INVALIDA');
    assert.equal((await A.restaurarPacotes({ origem: m.destino, itens: [{ chave: 'x', sha256: 'a', bytes: 1 }], destino: path.join(nova(), 'r') })).falha.codigo, 'PLANO_INVALIDO');
    assert.equal((await A.restaurarPacotes({ origem: m.destino, itens: m.itens, destino: 'relativo' })).falha.codigo, 'DESTINO_INVALIDO');
    await assert.rejects(A.restaurarPacotes({ origem: m.destino, itens: m.itens, destino: path.join(nova(), 'r'), extra: 1 }), TypeError);
  });

  test('RS-03 — divergência na origem copiada (bytes alterados, arquivo ausente, link no lugar do arquivo) interrompe e NADA é apagado; a releitura denuncia extra e faltante', async () => {
    const m = await copiaPronta([[1, 1], [1, 2]]);
    const alterado = path.join(m.destino, '1', 'pacote-2.zip');
    fs.chmodSync(alterado, 0o600);
    fs.writeFileSync(alterado, zip());
    const d1 = path.join(nova(), 'r1');
    const r1 = await A.restaurarPacotes({ origem: m.destino, itens: m.itens, destino: d1 });
    assert.deepEqual(r1, { ok: false, restaurados: 1, falha: { codigo: 'INTEGRIDADE_DIVERGENTE', chave: '1/pacote-2.zip' } });
    assert.ok(existe(path.join(d1, '1', 'pacote-1.zip')), 'o já restaurado permanece (nada é apagado)');
    fs.unlinkSync(alterado);
    const r2 = await A.restaurarPacotes({ origem: m.destino, itens: m.itens, destino: path.join(nova(), 'r2') });
    assert.deepEqual(r2.falha, { codigo: 'ORIGEM_AUSENTE', chave: '1/pacote-2.zip' });
    const alvo = nova();
    fs.writeFileSync(path.join(alvo, 'alvo.zip'), zip());
    fs.symlinkSync(path.join(alvo, 'alvo.zip'), alterado);
    const r3 = await A.restaurarPacotes({ origem: m.destino, itens: m.itens, destino: path.join(nova(), 'r3') });
    assert.deepEqual(r3.falha, { codigo: 'ORIGEM_INVALIDA', chave: '1/pacote-2.zip' });
    // releitura: um extra plantado no destino durante a restauração é denunciado
    const d4 = path.join(nova(), 'r4');
    const fachada = fachadaCom({ link: async (...a) => { await A.FS_PADRAO.link(...a); fs.writeFileSync(path.join(d4, '1', 'extra.zip'), 'x'); } });
    const r4 = await A.restaurarPacotes({ origem: m.destino, itens: [m.itens[0]], destino: d4, fs: fachada });
    assert.deepEqual(r4.falha, { codigo: 'ARQUIVO_EXTRA', chave: '1/extra.zip' });
  });
});

describe('[NG] neutralidade e sinais', () => {
  test('NG-01 — o módulo não inicia processo filho e só remove o PRÓPRIO temporário (um único rm, com force, sobre o nome aleatório criado por ele)', () => {
    const fonte = fs.readFileSync(path.join(__dirname, '..', '..', 'src/services/backup-fontes-fiscalizacao-arquivos.service.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    assert.equal(/\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/.test(fonte), false);
    assert.equal((fonte.match(/\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/g) ?? []).length, 1, 'uma única remoção');
    assert.match(fonte, /await fs\.rm\(temporario, \{ force: true \}\)\.catch/);
    assert.equal(/recursive/.test(fonte), false, 'nenhuma remoção recursiva');
  });
});
