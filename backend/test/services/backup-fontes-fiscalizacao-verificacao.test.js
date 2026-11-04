'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const V = require('../../src/services/backup-fontes-fiscalizacao-verificacao.service');
const R = require('../../src/repositories/fiscalizacao-verificacao.repository');

/**
 * D-ORF-6, P3 — VERIFICADOR da fonte `fiscalizacao-pacotes` (somente leitura). Prova, com banco falso e um diretório temporário exclusivo:
 * referências do banco × arquivos (hash, tamanho, assinatura ZIP), isolamento por empresa, sobras e geração em curso, links e estrutura estranha,
 * registros inconsistentes, paginação, e que nada é escrito nem removido (banco: só BEGIN READ ONLY, SELECT, ROLLBACK; disco: só lstat, readdir,
 * realpath e open). A classificação da fonte (D-F1) NÃO é decidida aqui.
 */

const AGORA = Date.UTC(2026, 10, 3, 12, 0, 0);
const HORA = 3600000;
const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const conteudoZip = (bytes = 2048) => Buffer.concat([Buffer.from('PK\x03\x04', 'latin1'), crypto.randomBytes(bytes - 4)]);

function gravar(raiz, empresaId, nome, conteudo, { idadeMs = 10 * HORA } = {}) {
  const pasta = path.join(raiz, String(empresaId));
  fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
  const arquivo = path.join(pasta, nome);
  fs.writeFileSync(arquivo, conteudo, { mode: 0o600 });
  const t = (AGORA - idadeMs) / 1000;
  fs.utimesSync(arquivo, t, t);
  return { sha256: sha(conteudo), tamanho: conteudo.length };
}

const linha = (id, empresaId, status, extra = {}) => ({
  id, empresa_id: empresaId, status, tamanho_bytes: null, sha256: null, chave_armazenamento: null, heartbeat_em: new Date(AGORA - HORA), ...extra,
});
const concluido = (id, empresaId, { sha256, tamanho }, chave = `${empresaId}/pacote-${id}.zip`) => linha(id, empresaId, 'CONCLUIDO', { tamanho_bytes: tamanho, sha256, chave_armazenamento: chave });

function bancoFalso({ pacotes = [], empresas = [1, 2] } = {}) {
  const sql = [];
  const pool = {
    async connect() {
      return {
        async query(texto, params) {
          const t = String(texto).trim();
          sql.push(t);
          if (/^BEGIN/i.test(t) || /^ROLLBACK/i.test(t)) return { rows: [] };
          if (/FROM fiscalizacao_pacotes/i.test(t)) {
            const depois = BigInt(params[0]);
            return { rows: pacotes.filter((p) => BigInt(p.id) > depois).sort((a, b) => Number(BigInt(a.id) - BigInt(b.id))).slice(0, params[1]) };
          }
          if (/FROM empresas/i.test(t)) return { rows: empresas.map((id) => ({ id })) };
          throw new Error(`SQL inesperado: ${t.slice(0, 60)}`);
        },
        release() { sql.push('RELEASE'); },
      };
    },
  };
  return { pool, sql };
}

function fachadaEspia() {
  const usados = new Set();
  const espia = {};
  for (const nome of ['lstat', 'readdir', 'realpath', 'open']) espia[nome] = (...a) => { usados.add(nome); return V.FS_DE_LEITURA[nome](...a); };
  espia.constants = V.FS_DE_LEITURA.constants;
  return { fs: espia, usados };
}

const verificar = (pool, raiz, extra = {}) => V.verificarFiscalizacao(pool, { diretorio: raiz, agora: () => AGORA, ...extra });
const achadosDe = (r, empresaId, pacoteId) => r.pacotes.find((p) => p.empresaId === String(empresaId) && p.pacoteId === String(pacoteId));
const sobrasDe = (r, empresaId) => r.sobras.filter((s) => s.empresaId === String(empresaId));

describe('[VF] contrato e somente leitura', () => {
  test('VF-01 — opções inválidas são TypeError: pool sem connect, diretório relativo ou com NUL, idade fora da faixa, relógio, fachada incompleta, página fora da faixa', async () => {
    const raiz = novaRaiz();
    const { pool } = bancoFalso();
    for (const [p, o] of [[{}, { diretorio: raiz }], [pool, { diretorio: 'relativo' }], [pool, { diretorio: `${raiz}\0x` }], [pool, { diretorio: raiz, idadeMinimaRecenteMinutos: -1 }],
      [pool, { diretorio: raiz, idadeMinimaRecenteMinutos: V.IDADE_MINIMA_RECENTE_MAXIMA_MINUTOS + 1 }], [pool, { diretorio: raiz, agora: 'x' }], [pool, { diretorio: raiz, fs: { lstat() {} } }],
      [pool, { diretorio: raiz, tamanhoDaPagina: 0 }], [pool, { diretorio: raiz, tamanhoDaPagina: R.LIMITE_MAXIMO + 1 }], [pool, null]]) {
      await assert.rejects(V.verificarFiscalizacao(p, o), TypeError);
    }
  });

  test('VF-02 — raiz ausente ou que não é diretório: veredito INVESTIGAR com o alerta, e o banco NEM é consultado', async () => {
    const { pool, sql } = bancoFalso();
    const ausente = await verificar(pool, path.join(novaRaiz(), 'nao-existe'));
    assert.deepEqual([ausente.veredito, ausente.alertas[0].codigo, ausente.raiz.estado], ['INVESTIGAR', 'RAIZ_AUSENTE', 'RAIZ_AUSENTE']);
    const raiz = novaRaiz();
    fs.writeFileSync(path.join(raiz, 'arquivo'), 'x');
    const invalida = await verificar(pool, path.join(raiz, 'arquivo'));
    assert.deepEqual([invalida.veredito, invalida.alertas[0].codigo], ['INVESTIGAR', 'RAIZ_INVALIDA']);
    assert.deepEqual(sql, [], 'nenhuma consulta');
  });

  test('VF-03 — a fotografia do banco é READ ONLY e REPEATABLE READ, só SELECT, encerrada com ROLLBACK e release; a fachada só usa lstat, readdir, realpath e open', async () => {
    const raiz = novaRaiz();
    const a = gravar(raiz, 1, 'pacote-10.zip', conteudoZip());
    const { pool, sql } = bancoFalso({ pacotes: [concluido(10, 1, a)] });
    const { fs: espia, usados } = fachadaEspia();
    const r = await verificar(pool, raiz, { fs: espia });
    assert.equal(r.veredito, 'INTEGRO');
    assert.equal(sql[0], 'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    assert.deepEqual(sql.slice(-2), ['ROLLBACK', 'RELEASE']);
    for (const s of sql.slice(1, -2)) assert.match(s, /^SELECT\b/, s);
    assert.deepEqual([...usados].sort(), ['lstat', 'open', 'readdir', 'realpath']);
    assert.ok(Object.isFrozen(r));
    assert.deepEqual(r.limites, [...V.LIMITES]);
  });
});

describe('[VF] referências × arquivos', () => {
  test('VF-04 — pacote íntegro: tamanho, SHA-256 e assinatura ZIP conferem; nada em pacotes nem sobras; contadores do resumo', async () => {
    const raiz = novaRaiz();
    const a = gravar(raiz, 1, 'pacote-1.zip', conteudoZip(5000));
    const b = gravar(raiz, 2, 'pacote-2.zip', conteudoZip(300 * 1024));
    const { pool } = bancoFalso({ pacotes: [concluido(1, 1, a), concluido(2, 2, b), linha(3, 1, 'FALHA'), linha(4, 2, 'GERANDO')] });
    const r = await verificar(pool, raiz);
    assert.deepEqual([r.veredito, r.pacotes, r.sobras], ['INTEGRO', [], []]);
    assert.deepEqual(r.registros, { total: 4, concluidos: 2, gerando: 1, falha: 1, invalidos: 0 });
    assert.deepEqual(r.resumo, { esperados: 2, integros: 2, ausentes: 0, divergentes: 0, naoVerificados: 0, sobras: 0, recentes: 0 });
    assert.equal(r.fonte, V.FONTE);
  });

  test('VF-05 — ausente é RECUPERAVEL com o sintoma ACH-FISC-01; tamanho, SHA-256 e assinatura divergentes são INVESTIGAR; o veredito é a pior classe', async () => {
    const raiz = novaRaiz();
    const ok = gravar(raiz, 1, 'pacote-1.zip', conteudoZip());
    const grande = gravar(raiz, 1, 'pacote-2.zip', conteudoZip());
    const trocado = gravar(raiz, 1, 'pacote-3.zip', conteudoZip());
    const semAssinatura = gravar(raiz, 1, 'pacote-4.zip', Buffer.concat([Buffer.from('NAO!'), crypto.randomBytes(100)]));
    const { pool } = bancoFalso({ pacotes: [
      concluido(1, 1, ok), concluido(2, 1, { ...grande, tamanho: grande.tamanho + 1 }), concluido(3, 1, { ...trocado, sha256: 'a'.repeat(64) }), concluido(4, 1, semAssinatura), concluido(5, 1, ok, '1/pacote-5.zip'),
    ] });
    const r = await verificar(pool, raiz);
    assert.equal(r.veredito, 'INVESTIGAR');
    assert.deepEqual(achadosDe(r, 1, 2).achados[0], { tipo: 'TAMANHO_DIVERGENTE', classe: 'INVESTIGAR', esperado: grande.tamanho + 1, encontrado: grande.tamanho });
    assert.deepEqual(achadosDe(r, 1, 3).achados[0], { tipo: 'SHA256_DIVERGENTE', classe: 'INVESTIGAR' });
    assert.deepEqual(achadosDe(r, 1, 4).achados[0], { tipo: 'ASSINATURA_DIVERGENTE', classe: 'INVESTIGAR' });
    assert.deepEqual(achadosDe(r, 1, 5).achados[0], { tipo: 'ARQUIVO_AUSENTE', classe: 'RECUPERAVEL', sintoma: 'ACH-FISC-01' });
    assert.equal(achadosDe(r, 1, 1), undefined, 'o íntegro não aparece');
    assert.deepEqual(r.resumo, { esperados: 5, integros: 1, ausentes: 1, divergentes: 3, naoVerificados: 0, sobras: 0, recentes: 0 });
    const soAusente = await verificar(bancoFalso({ pacotes: [concluido(5, 1, ok, '1/pacote-5.zip'), concluido(1, 1, ok)] }).pool, raiz);
    assert.equal(soAusente.veredito, 'RECUPERAVEL');
  });

  test('VF-06 — isolamento por empresa: a linha da empresa 1 cuja chave aponta para a pasta da empresa 2 é EMPRESA_DIVERGENTE e NÃO reivindica o arquivo, que fica como sobra da empresa 2', async () => {
    const raiz = novaRaiz();
    const alheio = gravar(raiz, 2, 'pacote-7.zip', conteudoZip());
    const { pool } = bancoFalso({ pacotes: [concluido(7, 1, alheio, '2/pacote-7.zip')] });
    const r = await verificar(pool, raiz);
    assert.deepEqual(achadosDe(r, 1, 7).achados[0], { tipo: 'EMPRESA_DIVERGENTE', classe: 'INVESTIGAR', campo: 'empresa' });
    assert.deepEqual(sobrasDe(r, 2).map((s) => [s.nome, s.tipo, s.classe, s.recente]), [['pacote-7.zip', 'SOBRA_SEM_REGISTRO', 'ORFAO', false]]);
    assert.equal(r.veredito, 'INVESTIGAR');
    assert.equal(r.registros.invalidos, 1);
  });

  test('VF-07 — registro inconsistente é INVESTIGAR sem tocar o disco por ele: chave fora do formato, id da chave diferente da linha, SHA-256 inválido, tamanho zero, status desconhecido', async () => {
    const raiz = novaRaiz();
    const a = gravar(raiz, 1, 'pacote-1.zip', conteudoZip());
    const { pool } = bancoFalso({ pacotes: [
      concluido(1, 1, a, '1/pacote-1.zip/../x'), concluido(2, 1, a, '1/pacote-9.zip'), concluido(3, 1, { ...a, sha256: 'ZZ' }, '1/pacote-3.zip'), concluido(4, 1, { ...a, tamanho: 0 }, '1/pacote-4.zip'), linha(5, 1, 'ESTRANHO'),
    ] });
    const r = await verificar(pool, raiz);
    assert.deepEqual(r.pacotes.map((p) => [p.pacoteId, p.achados[0].tipo, p.achados[0].campo]), [
      ['1', 'REGISTRO_INVALIDO', 'chave_armazenamento'], ['2', 'REGISTRO_INVALIDO', 'chave_armazenamento'], ['3', 'REGISTRO_INVALIDO', 'sha256'], ['4', 'REGISTRO_INVALIDO', 'tamanho_bytes'], ['5', 'REGISTRO_INVALIDO', 'status'],
    ]);
    assert.deepEqual(sobrasDe(r, 1).map((s) => s.nome), ['pacote-1.zip'], 'o arquivo real da linha inválida vira sobra, nunca é reivindicado por registro inválido');
    assert.equal(r.resumo.esperados, 0);
  });
});

describe('[VF] sobras, geração em curso, links e estrutura', () => {
  test('VF-08 — sobras: .tmp antigo, ZIP de tentativa FALHA e ZIP sem linha são ORFAO; arquivo de tentativa GERANDO é EM_GERACAO e arquivo recente fica fora do veredito', async () => {
    const raiz = novaRaiz();
    const a = gravar(raiz, 1, 'pacote-1.zip', conteudoZip());
    gravar(raiz, 1, 'pacote-2.tmp', Buffer.alloc(10));
    gravar(raiz, 1, 'pacote-3.zip', conteudoZip());
    gravar(raiz, 1, 'pacote-4.zip', conteudoZip());
    gravar(raiz, 1, 'pacote-5.tmp', Buffer.alloc(7));
    gravar(raiz, 1, 'pacote-6.zip', conteudoZip(), { idadeMs: 5 * 60000 });
    const { pool } = bancoFalso({ pacotes: [concluido(1, 1, a), linha(3, 1, 'FALHA'), linha(5, 1, 'GERANDO')] });
    const r = await verificar(pool, raiz);
    assert.deepEqual(sobrasDe(r, 1).map((s) => [s.nome, s.pacoteId, s.tipo, s.classe, s.recente]), [
      ['pacote-2.tmp', '2', 'SOBRA_TEMPORARIO', 'ORFAO', false],
      ['pacote-3.zip', '3', 'SOBRA_DE_TENTATIVA_FALHA', 'ORFAO', false],
      ['pacote-4.zip', '4', 'SOBRA_SEM_REGISTRO', 'ORFAO', false],
      ['pacote-5.tmp', '5', 'EM_GERACAO', 'INTEGRO', true],
      ['pacote-6.zip', '6', 'SOBRA_SEM_REGISTRO', 'ORFAO', true],
    ]);
    assert.equal(r.veredito, 'ORFAO');
    assert.deepEqual([r.resumo.sobras, r.resumo.recentes], [3, 2]);
    const soRecentes = await verificar(bancoFalso({ pacotes: [concluido(1, 1, a), linha(5, 1, 'GERANDO')] }).pool, raiz, { idadeMinimaRecenteMinutos: V.IDADE_MINIMA_RECENTE_MAXIMA_MINUTOS });
    assert.equal(soRecentes.veredito, 'INTEGRO', 'com idade mínima máxima, toda sobra é recente e não pesa no veredito');
  });

  test('VF-09 — links (raiz e empresa) nunca são seguidos e são INVESTIGAR; pasta e arquivo com nome estranho são ESTRUTURA_ESTRANHA; pasta de empresa inexistente é EMPRESA_INEXISTENTE; nomes são escapados', async () => {
    const raiz = novaRaiz();
    const a = gravar(raiz, 1, 'pacote-1.zip', conteudoZip());
    const vitima = novaRaiz();
    fs.writeFileSync(path.join(vitima, 'segredo.txt'), 'nunca lido');
    fs.symlinkSync(vitima, path.join(raiz, '3'));
    fs.symlinkSync(path.join(vitima, 'segredo.txt'), path.join(raiz, '1', 'pacote-2.zip'));
    fs.mkdirSync(path.join(raiz, 'estranha'));
    fs.writeFileSync(path.join(raiz, '1', 'nota\u0007.txt'), 'x');
    gravar(raiz, 99, 'pacote-8.zip', conteudoZip());
    const { pool } = bancoFalso({ pacotes: [concluido(1, 1, a)], empresas: [1, 2] });
    const r = await verificar(pool, raiz);
    const tipos = r.sobras.map((s) => [s.empresaId, s.nome, s.tipo, s.classe]);
    assert.deepEqual(tipos, [
      ['1', 'nota\\u0007.txt', 'ESTRUTURA_ESTRANHA', 'INVESTIGAR'],
      ['1', 'pacote-2.zip', 'ENTRADA_IMPROPRIA', 'INVESTIGAR'],
      [null, '3', 'ENTRADA_IMPROPRIA', 'INVESTIGAR'],
      ['99', 'pacote-8.zip', 'EMPRESA_INEXISTENTE', 'INVESTIGAR'],
      [null, 'estranha', 'ESTRUTURA_ESTRANHA', 'INVESTIGAR'],
    ]);
    assert.equal(r.veredito, 'INVESTIGAR');
    assert.equal(fs.readFileSync(path.join(vitima, 'segredo.txt'), 'utf8'), 'nunca lido');
    const texto = JSON.stringify(r);
    assert.ok(!texto.includes(raiz) && !texto.includes(vitima), 'nenhum caminho absoluto no relatório');
  });

  test('VF-10 — link no lugar do ZIP esperado: ENTRADA_IMPROPRIA (INVESTIGAR), sem seguir; o alvo não é lido', async () => {
    const raiz = novaRaiz();
    const vitima = novaRaiz();
    const conteudo = conteudoZip();
    fs.writeFileSync(path.join(vitima, 'alvo.zip'), conteudo);
    fs.mkdirSync(path.join(raiz, '1'));
    fs.symlinkSync(path.join(vitima, 'alvo.zip'), path.join(raiz, '1', 'pacote-1.zip'));
    const { pool } = bancoFalso({ pacotes: [concluido(1, 1, { sha256: sha(conteudo), tamanho: conteudo.length })] });
    const r = await verificar(pool, raiz);
    assert.deepEqual(achadosDe(r, 1, 1).achados[0], { tipo: 'ENTRADA_IMPROPRIA', classe: 'INVESTIGAR', entrada: 'LINK_SIMBOLICO' });
    assert.equal(r.resumo.naoVerificados, 1);
  });

  test('VF-11 — alertas: todos os esperados ausentes (NENHUM_ARQUIVO_ESPERADO_PRESENTE) e banco sem registro com arquivos antigos (BANCO_SEM_REGISTROS_COM_ARQUIVOS) são INVESTIGAR', async () => {
    const raiz = novaRaiz();
    const a = { sha256: 'b'.repeat(64), tamanho: 10 };
    fs.mkdirSync(path.join(raiz, '1'));
    const r1 = await verificar(bancoFalso({ pacotes: [concluido(1, 1, a), concluido(2, 1, a)] }).pool, raiz);
    assert.deepEqual([r1.veredito, r1.alertas.map((x) => x.codigo)], ['INVESTIGAR', ['NENHUM_ARQUIVO_ESPERADO_PRESENTE']]);
    gravar(raiz, 1, 'pacote-9.zip', conteudoZip());
    const r2 = await verificar(bancoFalso({ pacotes: [] }).pool, raiz);
    assert.deepEqual([r2.veredito, r2.alertas.map((x) => x.codigo), r2.sobras.length], ['INVESTIGAR', ['BANCO_SEM_REGISTROS_COM_ARQUIVOS'], 1]);
  });

  test('VF-12 — paginação por id: com página 2 e 5 tentativas o banco é lido em 3 consultas e todas as linhas entram na fotografia', async () => {
    const raiz = novaRaiz();
    const arquivos = [1, 2, 3, 4, 5].map((id) => concluido(id, 1, gravar(raiz, 1, `pacote-${id}.zip`, conteudoZip())));
    const { pool, sql } = bancoFalso({ pacotes: arquivos });
    const r = await verificar(pool, raiz, { tamanhoDaPagina: 2 });
    assert.equal(sql.filter((s) => /FROM fiscalizacao_pacotes/i.test(s)).length, 3);
    assert.deepEqual([r.veredito, r.registros.total, r.resumo.integros], ['INTEGRO', 5, 5]);
  });
});

describe('[VF] neutralidade perante a guarda P2', () => {
  test('VF-13 — o serviço e o repositório não contêm nenhum sinal de escrita, remoção ou processo filho (os mesmos padrões da guarda estática)', () => {
    const escrita = /\b(?:createWriteStream|writeFile|writeFileSync|appendFile|appendFileSync|copyFile|copyFileSync|link|linkSync|symlink|symlinkSync|rename|renameSync|mkdir|mkdirSync|truncate|truncateSync|ftruncate|ftruncateSync)\s*\(|\bO_(?:WRONLY|CREAT|RDWR|APPEND)\b/;
    const remocao = /\b(?:unlink|unlinkSync|rm|rmSync|rmdir|rmdirSync)\s*\(/;
    const filho = /\b(?:spawn|spawnSync|execFile|execFileSync|fork)\s*\(/;
    for (const arquivo of ['src/services/backup-fontes-fiscalizacao-verificacao.service.js', 'src/repositories/fiscalizacao-verificacao.repository.js']) {
      const fonte = fs.readFileSync(path.join(__dirname, '..', '..', arquivo), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
      assert.equal(escrita.test(fonte), false, `${arquivo}: escrita`);
      assert.equal(remocao.test(fonte), false, `${arquivo}: remoção`);
      assert.equal(filho.test(fonte), false, `${arquivo}: processo filho`);
    }
  });
});
