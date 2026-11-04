'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-SELAGEM-ARTEFATOS-1): SELAGEM do manifesto numa ÁREA DE PREPARAÇÃO. Só arquivos fictícios em diretórios temporários descartáveis do
 * próprio teste (prefixo `gepi-selagem-test-`). Nada aqui publica backup, usa banco, processo ou imagem real.
 *
 * QUATRO NÍVEIS DISTINTOS (nada abaixo promove um nível ao seguinte):
 *   1. manifesto correto EM MEMÓRIA (`construirManifesto`, já aprovado);
 *   2. manifesto SELADO no disco: `manifesto.json` (bytes canônicos) + `manifesto.sha256` (hash FORA do manifesto), relidos e conferidos por `lerManifesto`  <- escopo deste RED;
 *   3. área de preparação completa (imagens verificadas + dump + manifesto selado)  <- fora do escopo;
 *   4. conjunto PUBLICADO e, só depois de restauração independente, RECUPERÁVEL  <- fora do escopo (SEL-07 e SEL-08).
 *
 * REUTILIZAÇÃO (inspeção): `armazenamento-imagens` só aceita chaves de imagem (CTL-01) e `armazenamento-local` só chaves de pacote; nenhum serve a nomes de manifesto, então o GREEN precisa de um
 * módulo próprio que REPLIQUE o padrão já aprovado (temporário `O_CREAT|O_EXCL|O_NOFOLLOW` 0600 -> `sync` -> `link` que nunca sobrescreve), sem alterar os existentes. Nenhum código do projeto
 * sincroniza DIRETÓRIOS (`fsync` de diretório): é uma lacuna nova.
 *
 * INTERFACE PROPOSTA (provisória, nada em produção): src/services/imagem-backup-selagem.service.js exporta
 *   `criarSelagem({ operacoes? })` -> { selar({ area, resultado }), verificar({ area, esperado? }) } e `operacoesDoSistema()`;
 *   `operacoes` (injetável SÓ para observar a ordem e simular falhas; o padrão é o sistema real) = { abrirExclusivo(caminho) -> { escrever(buf), sincronizar(), fechar() }, ligar(origem, destino),
 *   remover(caminho), sincronizarDiretorio(caminho) };
 *   `selar`: `area` = caminho ABSOLUTO de um diretório existente, não link simbólico; `resultado` = o devolvido por `construirManifesto` (os bytes são REVALIDADOS por `lerManifesto` antes de qualquer
 *   escrita). Escreve `manifesto.json` (os bytes canônicos) e depois `manifesto.sha256` (`<hex>  manifesto.json\n`, formato do `sha256sum`), cada um por temporário + sync + link exclusivo; o
 *   arquivo de hash é o ÚLTIMO (marca de conclusão). Devolve { ok, selado, sha256, arquivos } ou { ok:false, selado:false, falha:{ codigo } } (códigos fixos, sem caminho nem mensagem de dependência);
 *   `verificar`: relê os dois arquivos (`O_NOFOLLOW`, arquivo regular, tamanho limitado), confere o formato do hash e delega o resto a `lerManifesto`; `esperado` ({ conjuntoId, sha256Manifesto })
 *   amarra a verificação à identidade da operação (um par manifesto+hash trocado por inteiro de OUTRO conjunto é detectado).
 *   Nenhum resultado tem `recuperavel`, `provaDeRestauracao`, `publicado` ou caminhos.
 *
 * LIMITES (honestos): sem `openat`/`renameat2` no Node, a proteção contra troca concorrente de diretório intermediário é parcial (TODO SEL-05); o `fsync` de diretório e a durabilidade real após queda
 * de energia NÃO são provas de teste (TODO SEL-06); publicação atômica de diretório sem sobrescrita NÃO tem contrato seguro com o que o Node oferece (SEL-07, documentado por controles).
 */

const MODULO = 'src/services/imagem-backup-selagem.service';
const selagemModulo = () => exigirModulo(MODULO);
const PRAZO = 20000;
const PREFIXO = 'gepi-selagem-test-';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const teste = (nome, fn) => test(nome, { timeout: PRAZO }, fn);
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const MANIFESTO = 'manifesto.json';
const HASH = 'manifesto.sha256';

const { construirManifesto } = require('../../src/services/imagem-backup-manifesto.service');
const PLANO = [{ chave: `7/${H('d')}/mestre.png`, sha256: H('e') }, { chave: `padrao/${H('a')}/mestre.png`, sha256: H('a') }];
const COPIA = { ok: true, completo: true, copiados: 2, falha: null, arquivos: [{ ...PLANO[0], bytes: 3 }, { ...PLANO[1], bytes: 5 }] };
const DUMP = { concluido: true, bytes: 1234, sha256Declarado: H('7'), sha256Recalculado: H('7') };
const construido = (conjuntoId = 'conjunto-sel-0001') => construirManifesto({
  contexto: { snapshotId: '0-0-0', banco: { nome: 'gestao_epi', oid: '16384' }, registros: {}, plano: PLANO.map((p) => ({ ...p })) },
  copia: JSON.parse(JSON.stringify(COPIA)), dump: { ...DUMP }, conjuntoId,
});

// ------------------------------------------------------------------------------------------------------------------------------- áreas descartáveis
const criadas = [];
function area() {
  const pasta = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
  fs.chmodSync(pasta, 0o700);
  criadas.push(pasta);
  return pasta;
}
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const pasta of criadas) if (path.dirname(pasta) === tmp && path.basename(pasta).startsWith(PREFIXO)) fs.rmSync(pasta, { recursive: true, force: true });
});
const listar = (pasta) => fs.readdirSync(pasta).sort();

/** Operações observáveis: registram o evento (com nome LÓGICO, sem sufixo temporário), executam ganchos `antes` e podem falhar num evento. */
function observar(base, { falharEm = null, antes = {} } = {}) {
  const registro = [];
  const logico = (c) => path.basename(c).replace(/\.[0-9a-f]+\.tmp$/, '');
  const evento = (e) => {
    registro.push(e);
    if (antes[e]) antes[e]();
    if (falharEm === e) throw new TypeError(`${SEGREDO} /Users/privado`);
  };
  const operacoes = {
    abrirExclusivo: async (caminho, ...resto) => {
      const n = logico(caminho);
      evento(`abrir:${n}`);
      const h = await base.abrirExclusivo(caminho, ...resto);
      return {
        escrever: async (b) => { evento(`escrever:${n}`); return h.escrever(b); },
        sincronizar: async () => { evento(`sincronizar:${n}`); return h.sincronizar(); },
        fechar: async () => { evento(`fechar:${n}`); return h.fechar(); },
      };
    },
    ligar: async (origem, destino) => { evento(`ligar:${path.basename(destino)}`); return base.ligar(origem, destino); },
    remover: async (caminho) => { evento(`remover:${logico(caminho)}`); return base.remover(caminho); },
    sincronizarDiretorio: async (caminho) => { evento('sincronizar-dir'); return base.sincronizarDiretorio(caminho); },
  };
  return { operacoes, registro };
}
const selagemDe = (operacoes) => selagemModulo().criarSelagem(operacoes ? { operacoes } : {});
const selar = (a, resultado = construido(), operacoes) => selagemDe(operacoes).selar({ area: a, resultado });
const verificar = (a, esperado) => selagemDe().verificar(esperado ? { area: a, esperado } : { area: a });
async function selada(conjuntoId) {
  const a = area();
  const r = construido(conjuntoId);
  const s = await selar(a, r);
  assert.equal(s.ok, true);
  return { a, r };
}
const semVazamento = (valor) => {
  const texto = JSON.stringify(valor);
  for (const proibido of [SEGREDO, '/Users/privado', os.tmpdir(), PREFIXO]) assert.equal(texto.includes(proibido), false, proibido);
};

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: o que já existe e o que NÃO serve', () => {
  teste('CTL-01 — o armazenamento de imagens só aceita chaves de imagem: não grava `manifesto.json` (por isso a selagem precisa de módulo próprio, sem alterar o existente)', async () => {
    const { criarArmazenamentoImagens } = exigirModulo('src/storage/armazenamento-imagens');
    const raiz = area();
    const armazenamento = criarArmazenamentoImagens({ diretorio: raiz });
    await assert.rejects(armazenamento.gravar('manifesto.json', Buffer.from('x'), { maxBytes: 10 }), (e) => e.codigo === 'CHAVE_INVALIDA');
    assert.deepEqual(listar(raiz), []);
  });

  teste('CTL-02 — o padrão reutilizável já provado: `link` NUNCA sobrescreve (EEXIST) e `O_EXCL` recusa criar sobre existente, inclusive link simbólico pendente', async () => {
    const pasta = area();
    const origem = path.join(pasta, 'a.tmp');
    const destino = path.join(pasta, 'b');
    fs.writeFileSync(origem, 'novo');
    fs.writeFileSync(destino, 'original');
    assert.throws(() => fs.linkSync(origem, destino), (e) => e.code === 'EEXIST');
    assert.equal(fs.readFileSync(destino, 'utf8'), 'original');
    const pendente = path.join(pasta, 'pendente');
    fs.symlinkSync(path.join(pasta, 'inexistente'), pendente);
    assert.throws(() => fs.openSync(pendente, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600), (e) => e.code === 'EEXIST');
    assert.equal(fs.existsSync(path.join(pasta, 'inexistente')), false);
  });

  teste('CTL-03 — SEL-07: publicar um DIRETÓRIO sem sobrescrita NÃO tem contrato seguro no Node: `rename` de diretório SUBSTITUI um destino vazio já existente; `link` não aceita diretório; não há `RENAME_NOREPLACE`', () => {
    const pasta = area();
    const origem = path.join(pasta, 'preparacao');
    const destino = path.join(pasta, 'publicado');
    fs.mkdirSync(origem);
    fs.writeFileSync(path.join(origem, 'x'), 'conteudo');
    fs.mkdirSync(destino); // um concorrente criou o destino (vazio) depois da verificação "não existe"
    fs.renameSync(origem, destino); // não falha: sobrescreveu
    assert.equal(fs.readFileSync(path.join(destino, 'x'), 'utf8'), 'conteudo');
    const outra = path.join(pasta, 'outra');
    fs.mkdirSync(outra);
    assert.throws(() => fs.linkSync(outra, path.join(pasta, 'link-dir')), (e) => ['EPERM', 'EACCES', 'ENOTSUP', 'EISDIR'].includes(e.code));
    assert.equal(fs.constants.RENAME_NOREPLACE, undefined);
    assert.equal(typeof fs.renameat2, 'undefined');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- SEL-01 / SEL-02
describe('[SEL-01 / SEL-02] escrita exclusiva e hash independente', () => {
  teste('SEL-01a — selar grava exatamente os bytes canônicos em `manifesto.json` (0600) e o hash em `manifesto.sha256` no formato `<hex>  manifesto.json\\n`; nada além deles resta (nenhum temporário)', async () => {
    const a = area();
    const r = construido();
    const s = await selar(a, r);
    assert.deepEqual(Object.keys(s).sort(), ['arquivos', 'ok', 'selado', 'sha256']);
    assert.equal(s.ok, true);
    assert.equal(s.selado, true);
    assert.equal(s.sha256, r.sha256);
    assert.deepEqual([...s.arquivos], [MANIFESTO, HASH]);
    assert.deepEqual(listar(a), [MANIFESTO, HASH]);
    assert.deepEqual(fs.readFileSync(path.join(a, MANIFESTO)), r.bytes);
    assert.equal(fs.readFileSync(path.join(a, HASH), 'utf8'), `${r.sha256}  ${MANIFESTO}\n`);
    for (const nome of [MANIFESTO, HASH]) assert.equal(fs.statSync(path.join(a, nome)).mode & 0o777, 0o600);
  });

  teste('SEL-02a — o hash vive FORA do manifesto: os bytes gravados não contêm o próprio hash (sem circularidade) e o arquivo de hash é separado', async () => {
    const { a, r } = await selada();
    assert.equal(fs.readFileSync(path.join(a, MANIFESTO), 'utf8').includes(r.sha256), false);
    assert.equal(sha(fs.readFileSync(path.join(a, MANIFESTO))), r.sha256);
  });

  teste('SEL-02b — RELEITURA: `verificar` lê de volta os dois arquivos do disco e devolve o manifesto validado por `lerManifesto`, com a mesma identidade da construção', async () => {
    const { a, r } = await selada();
    const v = await verificar(a, { ...r.identidade });
    assert.equal(v.ok, true);
    assert.equal(v.verificado, true);
    assert.equal(v.sha256, r.sha256);
    assert.deepEqual(v.manifesto, r.manifesto);
    assert.deepEqual({ ...v.identidade }, { ...r.identidade });
  });

  teste('SEL-01b — NUNCA sobrescreve: com `manifesto.json` ou `manifesto.sha256` pré-existentes (conteúdo igual ou diferente, arquivo ou link simbólico pendente) o resultado é DESTINO_EXISTENTE, nada é criado ou removido e o conteúdo alheio fica intacto', async () => {
    const r = construido();
    for (const preparar of [
      (a) => fs.writeFileSync(path.join(a, MANIFESTO), 'ALHEIO'),
      (a) => fs.writeFileSync(path.join(a, HASH), 'ALHEIO'),
      (a) => fs.writeFileSync(path.join(a, MANIFESTO), r.bytes),
      (a) => fs.symlinkSync(path.join(a, 'alvo-inexistente'), path.join(a, MANIFESTO)),
    ]) {
      const a = area();
      preparar(a);
      const antes = listar(a).map((n) => [n, fs.lstatSync(path.join(a, n)).isSymbolicLink() ? 'link' : fs.readFileSync(path.join(a, n), 'utf8')]);
      const s = await selar(a, r);
      assert.equal(s.ok, false);
      assert.equal(s.selado, false);
      assert.equal(s.falha.codigo, 'DESTINO_EXISTENTE');
      assert.deepEqual(listar(a).map((n) => [n, fs.lstatSync(path.join(a, n)).isSymbolicLink() ? 'link' : fs.readFileSync(path.join(a, n), 'utf8')]), antes);
      assert.equal(fs.existsSync(path.join(a, 'alvo-inexistente')), false);
      semVazamento(s);
    }
  });

  teste('SEL-01c — selar duas vezes na mesma área: a segunda é DESTINO_EXISTENTE e a primeira selagem continua íntegra e verificável', async () => {
    const { a, r } = await selada();
    const segunda = await selar(a, construido('conjunto-sel-0002'));
    assert.equal(segunda.ok, false);
    assert.equal(segunda.falha.codigo, 'DESTINO_EXISTENTE');
    assert.equal((await verificar(a, { ...r.identidade })).ok, true);
  });

  teste('SEL-01d — o `resultado` é REVALIDADO antes de qualquer escrita: bytes adulterados, hash incoerente ou objeto estranho dão ENTRADA_INVALIDA e a área fica vazia', async () => {
    const r = construido();
    const adulterados = Buffer.from(r.bytes);
    adulterados[adulterados.length - 8] ^= 1;
    for (const resultado of [{ bytes: adulterados, sha256: r.sha256 }, { bytes: r.bytes, sha256: H('0') }, { bytes: r.bytes, sha256: r.sha256.toUpperCase() }, null, 'x', {}]) {
      const a = area();
      const s = await selar(a, resultado);
      assert.equal(s.ok, false);
      assert.equal(s.falha.codigo, 'ENTRADA_INVALIDA');
      assert.deepEqual(listar(a), []);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- SEL-03
describe('[SEL-03] integridade na releitura: nada disso produz conjunto válido', () => {
  const casos = [
    ['manifesto TRUNCADO', (a, r) => fs.writeFileSync(path.join(a, MANIFESTO), r.bytes.subarray(0, r.bytes.length - 5)), 'MANIFESTO_INVALIDO'],
    ['manifesto VAZIO', (a) => fs.writeFileSync(path.join(a, MANIFESTO), Buffer.alloc(0)), 'MANIFESTO_INVALIDO'],
    ['manifesto ADULTERADO (um byte)', (a, r) => { const b = Buffer.from(r.bytes); b[b.length - 8] ^= 1; fs.writeFileSync(path.join(a, MANIFESTO), b); }, 'MANIFESTO_INVALIDO'],
    ['manifesto AUSENTE', (a) => fs.rmSync(path.join(a, MANIFESTO)), 'MANIFESTO_AUSENTE'],
    ['hash AUSENTE (selagem interrompida antes da marca de conclusão)', (a) => fs.rmSync(path.join(a, HASH)), 'HASH_AUSENTE'],
    ['manifesto NÃO CANÔNICO (reformatado) com o hash recalculado do arquivo reformatado', (a, r) => {
      const formatado = Buffer.from(JSON.stringify(JSON.parse(r.bytes.toString('utf8')), null, 2), 'utf8');
      fs.writeFileSync(path.join(a, MANIFESTO), formatado);
      fs.writeFileSync(path.join(a, HASH), `${sha(formatado)}  ${MANIFESTO}\n`);
    }, 'MANIFESTO_INVALIDO'],
    ['hash de OUTRO manifesto', (a) => fs.writeFileSync(path.join(a, HASH), `${H('0')}  ${MANIFESTO}\n`), 'MANIFESTO_INVALIDO'],
    ['hash em MAIÚSCULAS', (a, r) => fs.writeFileSync(path.join(a, HASH), `${r.sha256.toUpperCase()}  ${MANIFESTO}\n`), 'HASH_INVALIDO'],
    ['hash sem quebra de linha final', (a, r) => fs.writeFileSync(path.join(a, HASH), `${r.sha256}  ${MANIFESTO}`), 'HASH_INVALIDO'],
    ['hash com nome de arquivo diferente', (a, r) => fs.writeFileSync(path.join(a, HASH), `${r.sha256}  outro.json\n`), 'HASH_INVALIDO'],
    ['hash com linhas extras', (a, r) => fs.writeFileSync(path.join(a, HASH), `${r.sha256}  ${MANIFESTO}\n${r.sha256}  ${MANIFESTO}\n`), 'HASH_INVALIDO'],
    ['hash vazio', (a) => fs.writeFileSync(path.join(a, HASH), ''), 'HASH_INVALIDO'],
    ['manifesto substituído por LINK SIMBÓLICO para uma cópia idêntica', (a, r) => {
      fs.writeFileSync(path.join(a, 'copia.json'), r.bytes);
      fs.rmSync(path.join(a, MANIFESTO));
      fs.symlinkSync(path.join(a, 'copia.json'), path.join(a, MANIFESTO));
    }, 'ARQUIVO_INVALIDO'],
    ['hash substituído por DIRETÓRIO', (a) => { fs.rmSync(path.join(a, HASH)); fs.mkdirSync(path.join(a, HASH)); }, 'ARQUIVO_INVALIDO'],
  ];
  for (const [rotulo, estragar, codigo] of casos) {
    teste(`SEL-03 (${rotulo}) — ${codigo}, sem manifesto nem identidade no resultado`, async () => {
      const { a, r } = await selada();
      estragar(a, r);
      const v = await verificar(a);
      assert.equal(v.ok, false);
      assert.equal(v.falha.codigo, codigo);
      for (const proibida of ['manifesto', 'identidade', 'verificado', 'sha256', 'recuperavel']) assert.equal(Object.hasOwn(v, proibida), false, proibida);
      semVazamento(v);
    });
  }

  teste('SEL-03b — par manifesto+hash TROCADO por inteiro por outro conjunto (ambos coerentes entre si) é detectado quando se informa a identidade esperada: IDENTIDADE_DIVERGENTE', async () => {
    const { a, r } = await selada('conjunto-sel-A');
    const outro = construido('conjunto-sel-B');
    fs.rmSync(path.join(a, MANIFESTO));
    fs.rmSync(path.join(a, HASH));
    await selar(a, outro);
    assert.equal((await verificar(a)).ok, true, 'sozinho, o par trocado é internamente coerente');
    const v = await verificar(a, { ...r.identidade });
    assert.equal(v.ok, false);
    assert.equal(v.falha.codigo, 'IDENTIDADE_DIVERGENTE');
  });

  teste('SEL-03c — `esperado` malformado nunca é ignorado: identidade com hash inválido ou chaves extras dá ENTRADA_INVALIDA', async () => {
    const { a, r } = await selada();
    for (const esperado of [{ conjuntoId: r.identidade.conjuntoId, sha256Manifesto: 'x' }, { ...r.identidade, extra: 1 }, 'x', []]) {
      const v = await verificar(a, esperado);
      assert.equal(v.ok, false);
      assert.equal(v.falha.codigo, 'ENTRADA_INVALIDA');
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- SEL-04
describe('[SEL-04] falha parcial: nada concluído vale como conjunto; nada alheio é removido', () => {
  const falhas = ['abrir:manifesto.json', 'escrever:manifesto.json', 'sincronizar:manifesto.json', 'ligar:manifesto.json', 'abrir:manifesto.sha256', 'escrever:manifesto.sha256', 'sincronizar:manifesto.sha256', 'ligar:manifesto.sha256', 'sincronizar-dir'];
  for (const falharEm of falhas) {
    teste(`SEL-04 (falha em ${falharEm}) — ok:false com código fixo ESCRITA_FALHOU, sem eco da mensagem hostil; nenhum artefato próprio nem temporário sobra; o arquivo alheio fica; a verificação não aceita a área`, async () => {
      const { operacoesDoSistema } = selagemModulo();
      const a = area();
      fs.writeFileSync(path.join(a, 'alheio.txt'), 'ALHEIO');
      const { operacoes } = observar(operacoesDoSistema(), { falharEm });
      const s = await selar(a, construido(), operacoes);
      assert.equal(s.ok, false);
      assert.equal(s.selado, false);
      assert.equal(s.falha.codigo, 'ESCRITA_FALHOU');
      semVazamento(s);
      assert.deepEqual(listar(a), ['alheio.txt'], 'só o arquivo alheio permanece');
      assert.equal(fs.readFileSync(path.join(a, 'alheio.txt'), 'utf8'), 'ALHEIO');
      assert.equal((await verificar(a)).ok, false);
    });
  }

  teste('SEL-04b — CORRIDA no arquivo de hash: um concorrente cria `manifesto.sha256` depois da verificação inicial. O `link` falha (EEXIST), o `manifesto.json` PRÓPRIO é removido, o arquivo do concorrente fica intacto e o resultado é DESTINO_EXISTENTE', async () => {
    const { operacoesDoSistema } = selagemModulo();
    const a = area();
    const { operacoes } = observar(operacoesDoSistema(), { antes: { 'ligar:manifesto.sha256': () => fs.writeFileSync(path.join(a, HASH), 'DO-CONCORRENTE') } });
    const s = await selar(a, construido(), operacoes);
    assert.equal(s.ok, false);
    assert.equal(s.falha.codigo, 'DESTINO_EXISTENTE');
    assert.deepEqual(listar(a), [HASH]);
    assert.equal(fs.readFileSync(path.join(a, HASH), 'utf8'), 'DO-CONCORRENTE');
  });

  teste('SEL-04c — CORRIDA no manifesto: um concorrente cria `manifesto.json` antes do `link`. Nada próprio é publicado, o concorrente fica intacto e não sobra temporário', async () => {
    const { operacoesDoSistema } = selagemModulo();
    const a = area();
    const { operacoes } = observar(operacoesDoSistema(), { antes: { 'ligar:manifesto.json': () => fs.writeFileSync(path.join(a, MANIFESTO), 'DO-CONCORRENTE') } });
    const s = await selar(a, construido(), operacoes);
    assert.equal(s.ok, false);
    assert.equal(s.falha.codigo, 'DESTINO_EXISTENTE');
    assert.deepEqual(listar(a), [MANIFESTO]);
    assert.equal(fs.readFileSync(path.join(a, MANIFESTO), 'utf8'), 'DO-CONCORRENTE');
  });

  teste('SEL-04d — a limpeza só remove o que ESTA operação criou: temporários e finais próprios, nunca um nome que não publicou (verificado pelos eventos de remoção)', async () => {
    const { operacoesDoSistema } = selagemModulo();
    const a = area();
    fs.writeFileSync(path.join(a, 'alheio.txt'), 'ALHEIO');
    const { operacoes, registro } = observar(operacoesDoSistema(), { falharEm: 'sincronizar:manifesto.sha256' });
    await selar(a, construido(), operacoes);
    const remocoes = registro.filter((e) => e.startsWith('remover:'));
    assert.ok(remocoes.length > 0);
    for (const e of remocoes) assert.ok(['remover:manifesto.json', 'remover:manifesto.sha256'].includes(e), e);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- SEL-05
describe('[SEL-05] isolamento da área', () => {
  teste('SEL-05a — `area` precisa ser um caminho ABSOLUTO de diretório existente, sem NUL nem segmentos `..`; relativo, travessia, inexistente, arquivo ou tipo errado: AREA_INVALIDA sem nada criado', async () => {
    const base = area();
    const arquivo = path.join(base, 'arquivo');
    fs.writeFileSync(arquivo, 'x');
    const invalidas = ['relativo/dir', '.', '', `${base}/../${path.basename(base)}`, `${base}\0x`, path.join(base, 'inexistente'), arquivo, null, undefined, 123, {}];
    for (const a of invalidas) {
      const s = await selar(a);
      assert.equal(s.ok, false);
      assert.equal(s.falha.codigo, 'AREA_INVALIDA');
      semVazamento(s);
      const v = await verificar(a);
      assert.equal(v.ok, false);
      assert.equal(v.falha.codigo, 'AREA_INVALIDA');
    }
    assert.deepEqual(listar(base), ['arquivo']);
  });

  teste('SEL-05b — a área NÃO pode ser um link simbólico (nem para um diretório válido): AREA_INVALIDA, e o diretório de destino do link não recebe nada', async () => {
    const base = area();
    const real = path.join(base, 'real');
    fs.mkdirSync(real, { mode: 0o700 });
    const ligacao = path.join(base, 'ligacao');
    fs.symlinkSync(real, ligacao);
    const s = await selar(ligacao);
    assert.equal(s.ok, false);
    assert.equal(s.falha.codigo, 'AREA_INVALIDA');
    assert.deepEqual(listar(real), []);
  });

  teste('SEL-05c — um link simbólico plantado no nome do arquivo final (apontando para fora da área) nunca é seguido: DESTINO_EXISTENTE, o alvo externo não é criado nem alterado', async () => {
    const a = area();
    const fora = area();
    const alvo = path.join(fora, 'alvo');
    fs.writeFileSync(alvo, 'EXTERNO');
    fs.symlinkSync(alvo, path.join(a, HASH));
    const s = await selar(a);
    assert.equal(s.ok, false);
    assert.equal(s.falha.codigo, 'DESTINO_EXISTENTE');
    assert.equal(fs.readFileSync(alvo, 'utf8'), 'EXTERNO');
    assert.deepEqual(listar(fora), ['alvo']);
    assert.equal(fs.lstatSync(path.join(a, HASH)).isSymbolicLink(), true);
  });

  teste('SEL-05d — colisão entre conjuntos: duas áreas distintas guardam manifestos distintos sem interferência; cada verificação enxerga só a própria identidade', async () => {
    const um = await selada('conjunto-sel-um');
    const dois = await selada('conjunto-sel-dois');
    assert.notEqual(um.r.sha256, dois.r.sha256);
    assert.equal((await verificar(um.a, { ...um.r.identidade })).ok, true);
    assert.equal((await verificar(dois.a, { ...dois.r.identidade })).ok, true);
    assert.equal((await verificar(um.a, { ...dois.r.identidade })).falha.codigo, 'IDENTIDADE_DIVERGENTE');
  });

  teste('SEL-05e — os nomes dos arquivos são FIXOS e do módulo: nenhum campo do manifesto (`conjuntoId` com `../`, barras, nome de arquivo) influencia onde se escreve', async () => {
    for (const conjuntoId of ['../escapou', 'a/b/c', '..\\x', 'manifesto.sha256']) {
      const a = area();
      const s = await selar(a, construido(conjuntoId));
      assert.equal(s.ok, true);
      assert.deepEqual(listar(a), [MANIFESTO, HASH]);
      assert.equal(fs.existsSync(path.join(a, '..', 'escapou')), false);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- SEL-06
describe('[SEL-06] durabilidade: a ORDEM exigida (provável em teste); a durabilidade REAL não é provável aqui', () => {
  teste('SEL-06a — ordem por arquivo: abrir exclusivo -> escrever -> sincronizar o ARQUIVO -> fechar -> ligar ao nome final; nunca ligar antes de sincronizar', async () => {
    const { operacoesDoSistema } = selagemModulo();
    const a = area();
    const { operacoes, registro } = observar(operacoesDoSistema());
    assert.equal((await selar(a, construido(), operacoes)).ok, true);
    for (const nome of [MANIFESTO, HASH]) {
      const idx = (e) => registro.indexOf(`${e}:${nome}`);
      assert.ok(idx('abrir') >= 0 && idx('abrir') < idx('escrever') && idx('escrever') < idx('sincronizar') && idx('sincronizar') < idx('fechar') && idx('fechar') < idx('ligar'), `${nome}: ${registro.join(' > ')}`);
    }
  });

  teste('SEL-06b — o `manifesto.sha256` (marca de conclusão) só é aberto DEPOIS de o `manifesto.json` estar ligado ao nome final; cada tentativa de arquivo escreve uma única vez', async () => {
    const { operacoesDoSistema } = selagemModulo();
    const { operacoes, registro } = observar(operacoesDoSistema());
    await selar(area(), construido(), operacoes);
    assert.ok(registro.indexOf('ligar:manifesto.json') < registro.indexOf('abrir:manifesto.sha256'));
    assert.equal(registro.filter((e) => e === 'escrever:manifesto.json').length, 1);
    assert.equal(registro.filter((e) => e === 'escrever:manifesto.sha256').length, 1);
  });

  teste('SEL-06c — a ÚLTIMA operação antes de declarar sucesso é a sincronização do DIRETÓRIO da área, depois do último `ligar` e da remoção dos temporários; sem ela o resultado não é `selado`', async () => {
    const { operacoesDoSistema } = selagemModulo();
    const { operacoes, registro } = observar(operacoesDoSistema());
    const s = await selar(area(), construido(), operacoes);
    assert.equal(s.selado, true);
    assert.equal(registro[registro.length - 1], 'sincronizar-dir');
    assert.equal(registro.filter((e) => e === 'sincronizar-dir').length >= 1, true);
    assert.ok(registro.lastIndexOf('ligar:manifesto.sha256') < registro.lastIndexOf('sincronizar-dir'));
    assert.ok(registro.lastIndexOf('remover:manifesto.sha256') < registro.lastIndexOf('sincronizar-dir'));
  });

  teste('SEL-06d — o resultado não faz nenhuma afirmação de durabilidade: nenhum campo `duravel`, `persistido` ou equivalente (isso só se comprova no sistema operacional real)', async () => {
    const s = await selar(area());
    for (const chave of Object.keys(s)) assert.equal(/durav|persist|fsync|publicad|recuper/i.test(chave), false, chave);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- SEL-08
describe('[SEL-08] recuperabilidade', () => {
  teste('SEL-08 — nenhum resultado da selagem ou da verificação declara `recuperavel`, `provaDeRestauracao`, `restaurado` ou `publicado`', async () => {
    const { a, r } = await selada();
    const resultados = [await selar(area()), await verificar(a, { ...r.identidade }), await verificar(area()), await selar(a)];
    for (const x of resultados) {
      const texto = JSON.stringify(x).toLowerCase();
      for (const proibida of ['recuper', 'prova', 'restaur', 'publicad']) assert.equal(texto.includes(proibida), false, proibida);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- pendências
describe('[PENDÊNCIAS] registradas, NÃO executadas', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('SEL-05f — TOCTOU em diretórios intermediários e na própria área: sem `openat`/`renameat2` no Node, `lstat`/`realpath` não provam ausência de troca concorrente; exige descritor de diretório (ou processo/OS dedicado)', 'limite da plataforma');
  todo('SEL-06e — durabilidade REAL após queda de energia (`fsync` de arquivo e de diretório honrados pelo sistema de arquivos e pelo dispositivo): validação no sistema operacional/infraestrutura de destino, não em teste simulado', 'validação real');
  todo('SEL-07 — PUBLICAÇÃO atômica do diretório de preparação sem sobrescrever destino existente: sem contrato seguro (CTL-03). Alternativas a decidir: marca de conclusão por `link` exclusivo, destino com identificador único gerado pela operação, ou mecanismo externo (S3 com condição de criação)', 'decisão de arquitetura');
  todo('SEL-09 — limpeza de áreas de preparação ÓRFÃS de operações interrompidas (propriedade comprovada por marca da operação) e política de retenção', 'incremento próprio');
  todo('SEL-10 — autenticidade: o SHA-256 em arquivo ao lado do manifesto não impede forjar os dois juntos; assinatura/HMAC ou canal confiável para o hash', 'decisão de segurança');
});
