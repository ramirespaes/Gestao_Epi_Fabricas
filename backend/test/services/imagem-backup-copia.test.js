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

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-COPIA-VERIFICADA-1): CÓPIA VERIFICADA das imagens do plano para uma área de preparação isolada. Os testes criam, e só
 * eles limpam, diretórios temporários descartáveis (prefixo `gepi-copia-test-`, confinados ao diretório temporário do sistema) com arquivos fictícios pequenos e hashes reais calculados
 * sobre eles. Nenhuma imagem real, PostgreSQL ou processo.
 *
 * CONTRATO REAL CONFIRMADO (lido no código):
 *   - o consumidor chama `copia(contexto)` (entrada operacional) com o `contexto` CONGELADO do snapshot: `{ snapshotId, banco, registros, plano }`; o `plano` é a lista de `{ chave, sha256 }`
 *     do planejador (ou `null` se o snapshot não tinha planejador); o coordenador só lê `ok === true` do resultado da etapa; `avaliar` NÃO recebe o resultado da cópia (só `{ etapas }`), então
 *     quem monta o manifesto (etapa futura) o faz por fechamento sobre o resultado da cópia; `avaliarConjunto` compara `manifesto.arquivos` ({ chave, sha256 }) com a `listaDoSnapshot`;
 *   - `criarArmazenamentoImagens({ diretorio })` já oferece o que a cópia precisa: `abrir(chave)` (lstat por componente, O_NOFOLLOW no arquivo, recusa link simbólico e tipo errado, fluxo de leitura),
 *     `existe(chave)` e `gravar(chave, fonte, { maxBytes, sha256Esperado })` (temporário 0600 exclusivo, SHA-256 dos bytes ESCRITOS conferido contra o esperado, publicação por `link` que NUNCA
 *     sobrescreve, pastas 0700, remove só o próprio temporário na falha, e REAPROVEITA em silêncio uma chave existente com os mesmos bytes). Detalhe: a fábrica CRIA o diretório raiz se não existir
 *     e resolve a raiz por `realpath`.
 *
 * INTERFACE MÍNIMA PROPOSTA (provisória; nomes ainda NÃO aprovados; nada de produção foi alterado): src/services/imagem-backup-copia.service.js exporta
 * `criarCopiaDeImagens({ origem, destino, maxBytesPorArquivo })` -> `copia(contexto)` assíncrona, onde `origem` e `destino` são instâncias do armazenamento de imagens (`abrir`/`existe`/`gravar`; injetadas
 * só para este contrato provisório e os testes, D8) e `maxBytesPorArquivo` é um inteiro positivo.
 *   resultado congelado: { ok, completo, arquivos, copiados, falha }
 *     - `arquivos`: SOMENTE quando `ok` (na ordem do plano): [{ chave, sha256, bytes }], com o SHA-256 e os bytes RECALCULADOS sobre os bytes gravados (iguais ao declarado). Em qualquer falha é [], para
 *       que ninguém monte manifesto de um conjunto parcial; `copiados` conta os itens já gravados e verificados (informativo);
 *     - `falha`: null ou { codigo, chave | null }, códigos fixos: PLANO_INVALIDO, ORIGEM_AUSENTE, ORIGEM_INVALIDA, DESTINO_INVALIDO, DESTINO_EXISTENTE, INTEGRIDADE_DIVERGENTE, LIMITE_EXCEDIDO, COPIA_FALHOU;
 *       NUNCA caminho absoluto, nome de temporário, mensagem de dependência ou conteúdo;
 *   - lê `contexto.plano` (nenhuma segunda representação do plano); plano vazio é legítimo (ok, completo, nada copiado); `plano` nulo ou fora do formato é PLANO_INVALIDO antes de qualquer E/S;
 *     a chave é revalidada (formato do armazenamento) antes de tocar o disco; itens na ordem do plano; PARA no primeiro erro (conservador); nunca altera o plano nem o contexto;
 *   - destino EXISTENTE (mesmo com bytes idênticos, inclusive o `reaproveitado` silencioso do `gravar`) é DESTINO_EXISTENTE: criação exclusiva, nada é sobrescrito nem removido;
 *   - POLÍTICA DE PARCIAIS: o temporário de uma gravação falha é removido pelo próprio `gravar`; arquivos JÁ publicados e verificados de itens anteriores NÃO são apagados (nenhuma exclusão
 *     genérica ou destrutiva) mas o conjunto NÃO é completo nem entra em nenhuma publicação: a decisão sobre a área de preparação é da etapa de manifesto e composição;
 *   - uma cópia concluída NÃO é prova de restauração: o resultado não tem campo de recuperabilidade nem manifesto.
 *
 * LIMITES (honestidade): a proteção contra links é por `lstat` de cada componente seguido de `open` com O_NOFOLLOW SÓ no arquivo final; o Node não oferece `openat`, então uma troca CONCORRENTE de
 * componente intermediário entre o `lstat` e o `open` não é excluída por estes testes (TODO COP-11). O snapshot do PostgreSQL não congela arquivos: imagem que some ou muda durante a cópia falha
 * de forma conservadora, e a trava de escrita ainda não cobre todos os escritores (bloqueio de homologação).
 *
 * COMO LER: o módulo NÃO existe; as falhas por "módulo ausente" NÃO são provas comportamentais independentes. Os CTL-* passam hoje e provam que as fixtures exercitam os casos desejados.
 */

const MODULO = 'src/services/imagem-backup-copia.service';
const copiaDe = () => exigirModulo(MODULO);
const PRAZO_DO_TESTE = 15000;
const PREFIXO = 'gepi-copia-test-';
const ID_SNAPSHOT = '0000000A-0000002B-7';
const LIMITE = 4096;
const teste = (nome, fn) => test(nome, { timeout: PRAZO_DO_TESTE }, fn);

const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const congelar = (v) => { if (v !== null && typeof v === 'object') for (const x of Object.values(v)) congelar(x); return Object.freeze(v); };

// ------------------------------------------------------------------------------------------------------------------------------- áreas descartáveis
const areas = [];
/** Cria um diretório temporário exclusivo do teste, com `origem` e `destino` dentro; só o próprio teste o apaga. */
function novoMundo() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
  areas.push(raiz);
  const dirOrigem = path.join(raiz, 'origem');
  const dirDestino = path.join(raiz, 'destino');
  const fora = path.join(raiz, 'fora');
  for (const d of [dirOrigem, dirDestino, fora]) fs.mkdirSync(d, { mode: 0o700 });
  return { raiz, dirOrigem, dirDestino, fora, origem: criarArmazenamentoImagens({ diretorio: dirOrigem }), destino: criarArmazenamentoImagens({ diretorio: dirDestino }) };
}

after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const raiz of areas) {
    // Confinamento: só apaga o que ESTE arquivo criou, direto sob o diretório temporário e com o prefixo próprio.
    if (path.dirname(raiz) === tmp && path.basename(raiz).startsWith(PREFIXO)) fs.rmSync(raiz, { recursive: true, force: true });
  }
});

function listarArquivos(base) {
  const achados = [];
  const andar = (dir, prefixo) => {
    for (const entrada of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefixo === '' ? entrada.name : `${prefixo}/${entrada.name}`;
      if (entrada.isDirectory()) andar(path.join(dir, entrada.name), rel);
      else achados.push(rel);
    }
  };
  andar(base, '');
  return achados.sort();
}

/** Grava um arquivo fictício na ORIGEM pelo armazenamento real e devolve o item do plano. */
async function semear(mundo, chave, conteudo) {
  const bytes = Buffer.from(conteudo);
  await mundo.origem.gravar(chave, bytes, { maxBytes: LIMITE, sha256Esperado: sha(bytes) });
  return { chave, sha256: sha(bytes) };
}

const contexto = (plano) => congelar({ snapshotId: ID_SNAPSHOT, banco: { nome: 'gestao_epi', oid: '16384' }, registros: { padrao: [], empresa: [] }, plano });
const copiar = (mundo, plano, extras = {}) => copiaDe().criarCopiaDeImagens({ origem: mundo.origem, destino: mundo.destino, maxBytesPorArquivo: LIMITE, ...extras })(contexto(plano));
const bytesDe = (dir, chave) => fs.readFileSync(path.join(dir, ...chave.split('/')));
const CHAVES_DO_RESULTADO = ['arquivos', 'completo', 'copiados', 'falha', 'ok'];

function semCaminhos(valor, mundo, rotulo) {
  const texto = JSON.stringify(valor);
  for (const trecho of [mundo.raiz, mundo.dirOrigem, mundo.dirDestino, os.tmpdir(), '.tmp', PREFIXO]) assert.equal(texto.includes(trecho), false, `${rotulo}: não pode conter "${trecho}"`);
}

/** Cenário padrão: três arquivos fictícios, dois de uma empresa e um do padrão, já com o plano na ordem das chaves. */
async function cenario() {
  const mundo = novoMundo();
  const h1 = sha(Buffer.from('mestre-padrao'));
  const h2 = sha(Buffer.from('mestre-empresa-7'));
  const itens = [
    await semear(mundo, `7/${h2}/mestre.png`, 'mestre-empresa-7'),
    await semear(mundo, `7/${h2}/miniatura.webp`, 'miniatura-empresa-7'),
    await semear(mundo, `padrao/${h1}/mestre.png`, 'mestre-padrao'),
  ];
  return { mundo, plano: itens };
}

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: as fixtures exercitam os casos e o armazenamento tem o comportamento em que a cópia se apoia', () => {
  teste('CTL-01 — as fixtures: a origem guarda bytes fictícios com hashes reais, `abrir` devolve exatamente esses bytes, e o destino começa vazio', async () => {
    const { mundo, plano } = await cenario();
    for (const item of plano) {
      const partes = [];
      for await (const bloco of await mundo.origem.abrir(item.chave)) partes.push(bloco);
      assert.equal(sha(Buffer.concat(partes)), item.sha256);
      assert.equal(sha(bytesDe(mundo.dirOrigem, item.chave)), item.sha256);
    }
    assert.deepEqual(listarArquivos(mundo.dirDestino), []);
  });

  teste('CTL-02 — `gravar` real: SHA-256 divergente é recusado sem deixar nenhum arquivo nem temporário; chave existente com os mesmos bytes é REAPROVEITADA em silêncio (por isso a cópia precisa recusá-la); com bytes diferentes é recusada', async () => {
    const m = novoMundo();
    const bytes = Buffer.from('conteudo-ctl');
    const chave = `7/${sha(bytes)}/mestre.png`;
    await assert.rejects(() => m.destino.gravar(chave, bytes, { maxBytes: LIMITE, sha256Esperado: sha(Buffer.from('outro')) }), (erro) => erro.codigo === 'INTEGRIDADE_DIVERGENTE');
    assert.deepEqual(listarArquivos(m.dirDestino), []);
    const primeira = await m.destino.gravar(chave, bytes, { maxBytes: LIMITE, sha256Esperado: sha(bytes) });
    assert.equal(primeira.reaproveitado, false);
    const segunda = await m.destino.gravar(chave, bytes, { maxBytes: LIMITE, sha256Esperado: sha(bytes) });
    assert.equal(segunda.reaproveitado, true);
    await assert.rejects(() => m.destino.gravar(chave, Buffer.from('bytes-diferentes'), { maxBytes: LIMITE }), (erro) => erro.codigo === 'CHAVE_COM_CONTEUDO_DIFERENTE');
    assert.deepEqual(bytesDe(m.dirDestino, chave), bytes);
  });

  teste('CTL-03 — `abrir` real recusa link simbólico (no arquivo e em componente da chave) e arquivo ausente, e o `avaliarConjunto` real aceita `{chave, sha256}` de uma cópia', async () => {
    const m = novoMundo();
    const bytes = Buffer.from('conteudo-ctl3');
    const h = sha(bytes);
    const chave = `7/${h}/mestre.png`;
    await assert.rejects(() => m.origem.abrir(chave), (erro) => erro.codigo === 'ARQUIVO_AUSENTE');
    fs.mkdirSync(path.join(m.fora, h), { recursive: true });
    fs.writeFileSync(path.join(m.fora, h, 'mestre.png'), bytes);
    fs.symlinkSync(m.fora, path.join(m.dirOrigem, '7'));
    await assert.rejects(() => m.origem.abrir(chave), (erro) => erro.codigo === 'CHAVE_INVALIDA');
    const { avaliarConjunto } = exigirModulo('src/services/imagem-backup.service');
    const lista = [{ chave, sha256: h }];
    const r = avaliarConjunto({
      saidaDoProcedimento: 0, relatorio: { veredito: 'VALIDO' }, manifesto: { arquivos: lista }, listaDoSnapshot: lista, verificacao: { concluida: true, ok: true },
      dump: { concluido: true, bytes: 10, sha256Declarado: 'a'.repeat(64), sha256Recalculado: 'a'.repeat(64) }, identidade: { conjuntoId: 'c-1', sha256Manifesto: 'b'.repeat(64) },
    });
    assert.equal(r.valido, true);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COP-01
describe('[COP-01] cópia íntegra', () => {
  teste('COP-01 — três arquivos copiados na ORDEM do plano: ok, completo, `arquivos` com chave, SHA-256 e bytes recalculados; o destino tem os mesmos bytes (hash conferido de forma independente), as mesmas chaves, arquivos 0600 e pastas 0700; o plano e o contexto não mudam', async () => {
    const { mundo, plano } = await cenario();
    const ctx = contexto(plano);
    const antes = JSON.stringify(ctx);
    const r = await copiaDe().criarCopiaDeImagens({ origem: mundo.origem, destino: mundo.destino, maxBytesPorArquivo: LIMITE })(ctx);
    assert.deepEqual(Object.keys(r).sort(), CHAVES_DO_RESULTADO);
    assert.equal(r.ok, true);
    assert.equal(r.completo, true);
    assert.equal(r.falha, null);
    assert.equal(r.copiados, 3);
    assert.deepEqual(r.arquivos.map((a) => a.chave), plano.map((p) => p.chave));
    for (const [i, a] of r.arquivos.entries()) {
      assert.deepEqual(Object.keys(a).sort(), ['bytes', 'chave', 'sha256']);
      assert.equal(a.sha256, plano[i].sha256);
      const lidos = bytesDe(mundo.dirDestino, a.chave);
      assert.equal(sha(lidos), plano[i].sha256, 'hash dos bytes realmente gravados');
      assert.equal(a.bytes, lidos.length);
      assert.deepEqual(lidos, bytesDe(mundo.dirOrigem, a.chave));
      assert.equal(fs.statSync(path.join(mundo.dirDestino, ...a.chave.split('/'))).mode & 0o777, 0o600);
    }
    for (const pasta of ['7', `7/${plano[0].chave.split('/')[1]}`, 'padrao']) assert.equal(fs.statSync(path.join(mundo.dirDestino, pasta)).mode & 0o777, 0o700);
    assert.deepEqual(listarArquivos(mundo.dirDestino), plano.map((p) => p.chave).sort());
    assert.equal(JSON.stringify(ctx), antes, 'o contexto congelado e o plano continuam iguais');
    assert.equal(Object.isFrozen(r), true);
  });

  teste('COP-01b — o resultado atende ao consumidor: `ok === true` (o que o coordenador lê) e nenhum campo de recuperabilidade ou manifesto: uma cópia concluída NÃO é prova de restauração', async () => {
    const { mundo, plano } = await cenario();
    const r = await copiar(mundo, plano);
    assert.equal(r.ok, true);
    for (const campo of ['recuperavel', 'manifesto', 'sha256Manifesto', 'restaurado']) assert.equal(Object.hasOwn(r, campo), false, campo);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COP-02 / 03
describe('[COP-02/03] hash divergente e arquivo ausente: falha explícita, nada íntegro, nada inventado', () => {
  teste('COP-02 — a origem NÃO bate com o SHA-256 declarado: INTEGRIDADE_DIVERGENTE com a chave; ok e completo false; `arquivos` vazio; nenhum arquivo nem temporário desse item no destino; sem caminhos no resultado', async () => {
    const { mundo, plano } = await cenario();
    fs.writeFileSync(path.join(mundo.dirOrigem, ...plano[1].chave.split('/')), Buffer.from('bytes-adulterados'));
    const r = await copiar(mundo, plano);
    assert.equal(r.ok, false);
    assert.equal(r.completo, false);
    assert.deepEqual(r.falha, { codigo: 'INTEGRIDADE_DIVERGENTE', chave: plano[1].chave });
    assert.deepEqual(r.arquivos, []);
    assert.equal(fs.existsSync(path.join(mundo.dirDestino, ...plano[1].chave.split('/'))), false);
    assert.equal(listarArquivos(mundo.dirDestino).some((f) => f.endsWith('.tmp')), false);
    semCaminhos(r, mundo, 'resultado');
  });

  teste('COP-02b — o plano é o que vale: o hash declarado diferente dos bytes REAIS da origem também falha (a cópia não confia na origem nem no banco, só na conferência dos bytes gravados)', async () => {
    const { mundo, plano } = await cenario();
    const adulterado = plano.map((p, i) => (i === 0 ? { ...p, sha256: 'f'.repeat(64) } : p));
    const r = await copiar(mundo, adulterado);
    assert.equal(r.ok, false);
    assert.equal(r.falha.codigo, 'INTEGRIDADE_DIVERGENTE');
    assert.equal(r.falha.chave, plano[0].chave);
    assert.deepEqual(r.arquivos, []);
  });

  teste('COP-03 — arquivo previsto no plano e AUSENTE na origem: ORIGEM_AUSENTE com a chave; NENHUM arquivo vazio é criado no lugar; para no primeiro erro; `arquivos` vazio', async () => {
    const { mundo, plano } = await cenario();
    fs.rmSync(path.join(mundo.dirOrigem, ...plano[1].chave.split('/')));
    const r = await copiar(mundo, plano);
    assert.equal(r.ok, false);
    assert.deepEqual(r.falha, { codigo: 'ORIGEM_AUSENTE', chave: plano[1].chave });
    assert.deepEqual(r.arquivos, []);
    assert.equal(fs.existsSync(path.join(mundo.dirDestino, ...plano[1].chave.split('/'))), false, 'nada de arquivo vazio substituto');
    assert.equal(r.copiados, 1, 'só o item anterior, já gravado e verificado');
    assert.equal(fs.existsSync(path.join(mundo.dirDestino, ...plano[2].chave.split('/'))), false, 'o item seguinte nem é tentado');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COP-04
describe('[COP-04] links simbólicos e caminhos: recusados, sem tocar no que está fora', () => {
  teste('COP-04 — arquivo de origem que é LINK SIMBÓLICO (para um arquivo com o hash certo): ORIGEM_INVALIDA; nada é copiado; o alvo do link não é lido como se fosse a imagem', async () => {
    const { mundo, plano } = await cenario();
    const alvo = path.join(mundo.fora, 'decoy.png');
    fs.writeFileSync(alvo, bytesDe(mundo.dirOrigem, plano[0].chave));
    const caminho = path.join(mundo.dirOrigem, ...plano[0].chave.split('/'));
    fs.rmSync(caminho);
    fs.symlinkSync(alvo, caminho);
    const r = await copiar(mundo, plano);
    assert.equal(r.ok, false);
    assert.deepEqual(r.falha, { codigo: 'ORIGEM_INVALIDA', chave: plano[0].chave });
    assert.deepEqual(r.arquivos, []);
    assert.equal(r.copiados, 0);
    assert.deepEqual(listarArquivos(mundo.dirDestino), []);
  });

  teste('COP-04b — COMPONENTE da origem que é link simbólico (a pasta da empresa aponta para fora): ORIGEM_INVALIDA, nada copiado', async () => {
    const mundo = novoMundo();
    const bytes = Buffer.from('conteudo-fora');
    const h = sha(bytes);
    const chave = `7/${h}/mestre.png`;
    fs.mkdirSync(path.join(mundo.fora, h), { recursive: true });
    fs.writeFileSync(path.join(mundo.fora, h, 'mestre.png'), bytes);
    fs.symlinkSync(mundo.fora, path.join(mundo.dirOrigem, '7'));
    const r = await copiar(mundo, [{ chave, sha256: h }]);
    assert.deepEqual(r.falha, { codigo: 'ORIGEM_INVALIDA', chave });
    assert.deepEqual(listarArquivos(mundo.dirDestino), []);
  });

  teste('COP-04c — COMPONENTE do destino que é link simbólico (a pasta da empresa no destino aponta para fora): DESTINO_INVALIDO; NADA é escrito fora da área de preparação', async () => {
    const { mundo, plano } = await cenario();
    fs.symlinkSync(mundo.fora, path.join(mundo.dirDestino, '7'));
    const r = await copiar(mundo, plano);
    assert.equal(r.ok, false);
    assert.equal(r.falha.codigo, 'DESTINO_INVALIDO');
    assert.deepEqual(r.arquivos, []);
    assert.deepEqual(listarArquivos(mundo.fora), [], 'nada vazou para fora do destino');
  });

  const chavesRuins = [
    ['travessia', '../etc/passwd'], ['absoluta', '/etc/passwd'], ['travessia no meio', `padrao/../../${'a'.repeat(64)}/mestre.png`], ['extensão fora do formato', `padrao/${'a'.repeat(64)}/mestre.exe`],
    ['com ..', `padrao/${'a'.repeat(64)}/../mestre.png`], ['vazia', ''], ['com quebra de linha', `7/${'a'.repeat(64)}/mestre.png\n`], ['hash em maiúsculas', `7/${'A'.repeat(64)}/mestre.png`],
  ];
  for (const [rotulo, chave] of chavesRuins) {
    teste(`COP-04d (chave ${rotulo}) — PLANO_INVALIDO ANTES de qualquer E/S: a origem nem é aberta, o destino fica vazio, a chave hostil não é ecoada`, async () => {
      const mundo = novoMundo();
      const chamadas = [];
      const origem = { ...mundo.origem, abrir: async (c) => { chamadas.push(c); return mundo.origem.abrir(c); } };
      const r = await copiar(mundo, [{ chave, sha256: 'a'.repeat(64) }], { origem });
      assert.equal(r.ok, false);
      assert.deepEqual(r.falha, { codigo: 'PLANO_INVALIDO', chave: null });
      assert.deepEqual(chamadas, []);
      assert.deepEqual(listarArquivos(mundo.dirDestino), []);
      if (chave !== '') assert.equal(JSON.stringify(r).includes(chave), false);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- COP-05
describe('[COP-05] destino existente: criação exclusiva, nada sobrescrito, nada removido', () => {
  teste('COP-05 — arquivo JÁ existente no destino com os MESMOS bytes: DESTINO_EXISTENTE (o reaproveitamento silencioso do `gravar` não é aceito); o arquivo preexistente continua intacto e nada é removido', async () => {
    const { mundo, plano } = await cenario();
    await mundo.destino.gravar(plano[1].chave, bytesDe(mundo.dirOrigem, plano[1].chave), { maxBytes: LIMITE });
    const caminho = path.join(mundo.dirDestino, ...plano[1].chave.split('/'));
    const antes = fs.statSync(caminho);
    const r = await copiar(mundo, plano);
    assert.equal(r.ok, false);
    assert.deepEqual(r.falha, { codigo: 'DESTINO_EXISTENTE', chave: plano[1].chave });
    assert.deepEqual(r.arquivos, []);
    const depois = fs.statSync(caminho);
    assert.equal(depois.ino, antes.ino);
    assert.equal(depois.mtimeMs, antes.mtimeMs);
    assert.ok(fs.existsSync(caminho), 'o preexistente não foi removido');
  });

  teste('COP-05b — destino existente com bytes DIFERENTES: DESTINO_EXISTENTE; o conteúdo preexistente não é alterado nem apagado', async () => {
    const { mundo, plano } = await cenario();
    const caminho = path.join(mundo.dirDestino, ...plano[0].chave.split('/'));
    fs.mkdirSync(path.dirname(caminho), { recursive: true, mode: 0o700 });
    fs.writeFileSync(caminho, Buffer.from('preexistente-diferente'), { mode: 0o600 });
    const r = await copiar(mundo, plano);
    assert.deepEqual(r.falha, { codigo: 'DESTINO_EXISTENTE', chave: plano[0].chave });
    assert.deepEqual(fs.readFileSync(caminho), Buffer.from('preexistente-diferente'));
  });

  teste('COP-05c — CORRIDA: a verificação prévia diz que não existe, mas o `gravar` encontra a chave (reaproveitado): continua DESTINO_EXISTENTE e nada é sobrescrito', async () => {
    const { mundo, plano } = await cenario();
    await mundo.destino.gravar(plano[0].chave, bytesDe(mundo.dirOrigem, plano[0].chave), { maxBytes: LIMITE });
    const destino = { ...mundo.destino, existe: async () => false };
    const r = await copiar(mundo, plano, { destino });
    assert.deepEqual(r.falha, { codigo: 'DESTINO_EXISTENTE', chave: plano[0].chave });
    assert.deepEqual(r.arquivos, []);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COP-06
describe('[COP-06] falha durante a cópia: nenhum parcial tratado como íntegro, nenhuma publicação, só o temporário próprio é limpo', () => {
  const comOrigemQue = (mundo, chaveAlvo, fabricar) => ({ ...mundo.origem, abrir: async (c) => (c === chaveAlvo ? fabricar() : mundo.origem.abrir(c)) });

  teste('COP-06 — a leitura FALHA depois de entregar parte dos bytes: COPIA_FALHOU; o item não existe no destino; nenhum temporário sobra; `arquivos` vazio; os itens anteriores (já verificados) permanecem sem apagar, mas o conjunto NÃO é completo', async () => {
    const { mundo, plano } = await cenario();
    const origem = comOrigemQue(mundo, plano[1].chave, () => {
      let enviou = false;
      return new Readable({ read() { if (!enviou) { enviou = true; this.push(Buffer.from('parte-dos-bytes')); } else this.destroy(new Error(`falha simulada ${mundo.dirOrigem}`)); } });
    });
    const r = await copiar(mundo, plano, { origem });
    assert.equal(r.ok, false);
    assert.equal(r.completo, false);
    assert.deepEqual(r.falha, { codigo: 'COPIA_FALHOU', chave: plano[1].chave });
    assert.deepEqual(r.arquivos, []);
    assert.equal(r.copiados, 1);
    assert.equal(fs.existsSync(path.join(mundo.dirDestino, ...plano[1].chave.split('/'))), false);
    assert.equal(listarArquivos(mundo.dirDestino).some((f) => f.endsWith('.tmp')), false);
    assert.deepEqual(listarArquivos(mundo.dirDestino), [plano[0].chave], 'o item anterior verificado fica; nada é apagado');
    semCaminhos(r, mundo, 'resultado');
  });

  teste('COP-06b — os bytes lidos mudam no meio (conteúdo diferente do declarado): INTEGRIDADE_DIVERGENTE, sem arquivo nem temporário do item', async () => {
    const { mundo, plano } = await cenario();
    const origem = comOrigemQue(mundo, plano[2].chave, () => Readable.from([Buffer.from('primeira-parte'), Buffer.from('segunda-parte-diferente')]));
    const r = await copiar(mundo, plano, { origem });
    assert.deepEqual(r.falha, { codigo: 'INTEGRIDADE_DIVERGENTE', chave: plano[2].chave });
    assert.equal(listarArquivos(mundo.dirDestino).some((f) => f.endsWith('.tmp') || f.startsWith('padrao/')), false);
  });

  teste('COP-06c — arquivo maior que o limite por arquivo: LIMITE_EXCEDIDO, nada gravado nem temporário', async () => {
    const { mundo, plano } = await cenario();
    const r = await copiar(mundo, plano, { maxBytesPorArquivo: 8 });
    assert.equal(r.ok, false);
    assert.equal(r.falha.codigo, 'LIMITE_EXCEDIDO');
    assert.deepEqual(r.arquivos, []);
    assert.deepEqual(listarArquivos(mundo.dirDestino), []);
  });

  teste('COP-06d — a cópia NÃO apaga nada por conta própria: depois de uma falha no meio, os arquivos que já existiam na ORIGEM e no destino continuam todos presentes', async () => {
    const { mundo, plano } = await cenario();
    fs.rmSync(path.join(mundo.dirOrigem, ...plano[2].chave.split('/')));
    const origemAntes = listarArquivos(mundo.dirOrigem);
    const r = await copiar(mundo, plano);
    assert.equal(r.falha.codigo, 'ORIGEM_AUSENTE');
    assert.deepEqual(listarArquivos(mundo.dirOrigem), origemAntes);
    assert.deepEqual(listarArquivos(mundo.dirDestino), [plano[0].chave, plano[1].chave].sort());
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COP-07
describe('[COP-07] plano vazio, múltiplos arquivos, ordem determinística, isolamento entre empresas', () => {
  teste('COP-07 — plano VAZIO legítimo: ok, completo, nada copiado, destino continua vazio', async () => {
    const mundo = novoMundo();
    const r = await copiar(mundo, []);
    assert.equal(r.ok, true);
    assert.equal(r.completo, true);
    assert.deepEqual(r.arquivos, []);
    assert.equal(r.copiados, 0);
    assert.equal(r.falha, null);
    assert.deepEqual(listarArquivos(mundo.dirDestino), []);
  });

  teste('COP-07b — duas empresas com o MESMO hash de diretório e conteúdos diferentes: cada uma vai para a sua pasta, sem mistura; a ordem do resultado é a do plano e é a mesma em duas execuções em destinos novos', async () => {
    const mundo = novoMundo();
    const dir = sha(Buffer.from('original-compartilhado'));
    const itens = [
      await semear(mundo, `7/${dir}/mestre.png`, 'conteudo-da-empresa-7'),
      await semear(mundo, `8/${dir}/mestre.png`, 'conteudo-da-empresa-8'),
    ];
    const r1 = await copiar(mundo, itens);
    assert.equal(r1.ok, true);
    assert.deepEqual(bytesDe(mundo.dirDestino, itens[0].chave), Buffer.from('conteudo-da-empresa-7'));
    assert.deepEqual(bytesDe(mundo.dirDestino, itens[1].chave), Buffer.from('conteudo-da-empresa-8'));
    const outro = novoMundo();
    for (const item of itens) await outro.origem.gravar(item.chave, bytesDe(mundo.dirOrigem, item.chave), { maxBytes: LIMITE, sha256Esperado: item.sha256 });
    const r2 = await copiar(outro, itens);
    assert.deepEqual(r2.arquivos, r1.arquivos);
    assert.deepEqual(r1.arquivos.map((a) => a.chave), itens.map((i) => i.chave));
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COP-08
describe('[COP-08] compatibilidade com o contexto, o plano e o avaliador existentes; plano ausente ou fora do formato', () => {
  teste('COP-08 — o `arquivos` da cópia completa É o `manifesto.arquivos` que o `avaliarConjunto` real espera: com a `listaDoSnapshot` igual ao plano o conjunto é válido; com um conjunto PARCIAL (`arquivos` vazio) o avaliador aponta arquivo exigido ausente', async () => {
    const { mundo, plano } = await cenario();
    const { avaliarConjunto } = exigirModulo('src/services/imagem-backup.service');
    const entrada = (arquivos) => ({
      saidaDoProcedimento: 0, relatorio: { veredito: 'VALIDO' }, manifesto: { arquivos: arquivos.map((a) => ({ chave: a.chave, sha256: a.sha256 })) }, listaDoSnapshot: plano, verificacao: { concluida: true, ok: true },
      dump: { concluido: true, bytes: 10, sha256Declarado: 'a'.repeat(64), sha256Recalculado: 'a'.repeat(64) }, identidade: { conjuntoId: 'c-1', sha256Manifesto: 'b'.repeat(64) },
    });
    const completo = await copiar(mundo, plano);
    const valido = avaliarConjunto(entrada(completo.arquivos));
    assert.equal(valido.valido, true);
    assert.equal(valido.recuperavel, false);
    const adulterada = await copiar(novoMundoComOrigemDe(mundo, plano, 'bytes-adulterados'), plano);
    assert.deepEqual(adulterada.arquivos, []);
    assert.ok(avaliarConjunto(entrada(adulterada.arquivos)).motivos.includes('ARQUIVO_EXIGIDO_AUSENTE'));
  });

  const planosRuins = [
    ['nulo (snapshot sem planejador)', null], ['undefined', undefined], ['objeto', {}], ['texto', 'x'],
    ['item sem sha256', [{ chave: `padrao/${'a'.repeat(64)}/mestre.png` }]], ['item com campo extra', [{ chave: `padrao/${'a'.repeat(64)}/mestre.png`, sha256: 'a'.repeat(64), bytes: 3 }]],
    ['sha256 inválido', [{ chave: `padrao/${'a'.repeat(64)}/mestre.png`, sha256: 'xyz' }]], ['item que não é objeto', [null]],
    ['chave repetida', [{ chave: `padrao/${'a'.repeat(64)}/mestre.png`, sha256: 'a'.repeat(64) }, { chave: `padrao/${'a'.repeat(64)}/mestre.png`, sha256: 'a'.repeat(64) }]],
  ];
  for (const [rotulo, plano] of planosRuins) {
    teste(`COP-08b (plano ${rotulo}) — PLANO_INVALIDO antes de qualquer E/S; nada é tratado como "sem imagens"`, async () => {
      const mundo = novoMundo();
      const chamadas = [];
      const origem = { ...mundo.origem, abrir: async (c) => { chamadas.push(c); return mundo.origem.abrir(c); } };
      const r = await copiar(mundo, plano, { origem });
      assert.equal(r.ok, false);
      assert.deepEqual(r.falha, { codigo: 'PLANO_INVALIDO', chave: null });
      assert.deepEqual(r.arquivos, []);
      assert.deepEqual(chamadas, []);
      assert.deepEqual(listarArquivos(mundo.dirDestino), []);
    });
  }

  teste('COP-08c — a fábrica recusa parâmetros inválidos (TypeError): `origem`/`destino` sem as operações, limite não positivo, limite fracionário, chaves desconhecidas', () => {
    const m = novoMundo();
    const base = { origem: m.origem, destino: m.destino, maxBytesPorArquivo: LIMITE };
    const { criarCopiaDeImagens } = copiaDe();
    for (const ruim of [{ ...base, origem: {} }, { ...base, destino: {} }, { ...base, origem: null }, { ...base, maxBytesPorArquivo: 0 }, { ...base, maxBytesPorArquivo: -1 }, { ...base, maxBytesPorArquivo: 1.5 },
      { ...base, maxBytesPorArquivo: '10' }, { ...base, extra: 1 }, null, undefined]) {
      assert.throws(() => criarCopiaDeImagens(ruim), TypeError);
    }
  });
});

/** Mundo novo cuja origem tem os MESMOS caminhos do plano, mas com bytes adulterados. */
function novoMundoComOrigemDe(mundo, plano, conteudo) {
  const outro = novoMundo();
  for (const item of plano) {
    const caminho = path.join(outro.dirOrigem, ...item.chave.split('/'));
    fs.mkdirSync(path.dirname(caminho), { recursive: true, mode: 0o700 });
    fs.writeFileSync(caminho, Buffer.from(conteudo), { mode: 0o600 });
  }
  return outro;
}

// ------------------------------------------------------------------------------------------------------------------------------- COP-09
describe('[COP-09] sigilo: o resultado só leva códigos fixos e chaves do plano', () => {
  teste('COP-09 — em TODAS as falhas o resultado serializado não contém caminho absoluto, nome de temporário, mensagem de dependência nem conteúdo; `falha.codigo` é um código fixo', async () => {
    const codigos = new Set(['PLANO_INVALIDO', 'ORIGEM_AUSENTE', 'ORIGEM_INVALIDA', 'DESTINO_INVALIDO', 'DESTINO_EXISTENTE', 'INTEGRIDADE_DIVERGENTE', 'LIMITE_EXCEDIDO', 'COPIA_FALHOU']);
    const resultados = [];
    {
      const { mundo, plano } = await cenario();
      fs.writeFileSync(path.join(mundo.dirOrigem, ...plano[0].chave.split('/')), Buffer.from('adulterado'));
      resultados.push([mundo, await copiar(mundo, plano)]);
    }
    {
      const { mundo, plano } = await cenario();
      fs.rmSync(path.join(mundo.dirOrigem, ...plano[0].chave.split('/')));
      resultados.push([mundo, await copiar(mundo, plano)]);
    }
    {
      const { mundo, plano } = await cenario();
      const origem = { ...mundo.origem, abrir: async () => { throw Object.assign(new Error(`erro ${mundo.dirOrigem} password=SEGREDO-NUNCA-EXPOR-123`), { code: 'EACCES' }); } };
      resultados.push([mundo, await copiar(mundo, plano, { origem })]);
    }
    for (const [mundo, r] of resultados) {
      assert.equal(r.ok, false);
      assert.ok(codigos.has(r.falha.codigo), r.falha.codigo);
      semCaminhos(r, mundo, 'resultado');
      assert.equal(JSON.stringify(r).includes('SEGREDO-NUNCA-EXPOR-123'), false);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COP-11
describe('[COP-11] limites de comprovação e pendências (registradas, NÃO executadas)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('COP-11a — TOCTOU em componentes intermediários: o armazenamento confere cada componente por `lstat` e abre só o arquivo final com O_NOFOLLOW; o Node não oferece `openat`/descritor de diretório, então uma troca CONCORRENTE de um diretório intermediário entre a conferência e o `open` não é excluída por estes testes', 'limite da API do Node; mitigar com permissões e usuário dedicado');
  todo('COP-11b — a RAIZ da origem e a do destino são resolvidas por `realpath` pela fábrica do armazenamento: uma raiz que seja link simbólico é aceita em silêncio; a recusa de raízes que redirecionam para local não autorizado precisa de validação na composição/configuração', 'validação de configuração');
  todo('COP-11c — consistência do filesystem: o snapshot do PostgreSQL não congela arquivos; imagem que some ou muda durante a cópia falha de forma conservadora, mas a TRAVA de escrita ainda não cobre envio, importação do padrão e `completar-exibicao`: bloqueio de homologação operacional', 'bloqueio de homologação');
  todo('COP-11d — publicação ATÔMICA do conjunto completo, manifesto e hash do manifesto de forma não circular: incrementos próprios; aqui a área de preparação com itens verificados NÃO é um backup publicado', 'RED do manifesto e composição');
  todo('COP-11e — descarte da área de preparação após falha (arquivos já verificados de itens anteriores): decisão operacional; a cópia nunca apaga por conta própria', 'decisão operacional');
  todo('COP-11f — espaço em disco, `fsync` dos diretórios e limite total do conjunto', 'incremento futuro');
  todo('COP-11g — limite por arquivo derivado dos `bytes*` dos registros do contexto em vez de um teto único configurado', 'decisão de contrato');
});
