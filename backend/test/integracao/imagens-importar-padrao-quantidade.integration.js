'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro, arquivosSob } = require('../storage/helpers/tmp-seguro');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { abrirAmbienteImagens } = require('./helpers/imagem-material');
const h = require('../helpers/pacote-padrao-ficticio');
const { espiarPool, espiarObjeto, instantaneoDoArmazenamento, instantaneoDoBanco } = require('../helpers/instrumentacao-importacao');
const { pacote, ZIP_INTEGRO } = require('../helpers/cenarios-importacao-padrao');

// 31ª imagem padrão: um pacote de 1 imagem entra sobre as 30 já importadas, com PostgreSQL (schema temporário de gestao_epi_teste_local) e armazenamento reais.

const SERVICO = () => exigirModulo('src/services/imagem-padrao-importacao.service');
const CLI = () => exigirModulo('scripts/imagens-importar-padrao');
const NOME = 'Calça de Segurança Aluminizada';
const novo = h.recomporItem(NOME, { original: h.originalFicticio(NOME), padronizado: h.pngFicticio({ semente: NOME }), miniatura: h.webpFicticio({ semente: NOME }) });
const LEIA_ME = 'LEIA-ME (FICTÍCIO)\r\n';
const zipDe = (itens) => h.zipDoPacote(Object.freeze({ itens: Object.freeze(itens), manifesto: h.manifestoCsv(itens), leiaMe: LEIA_ME }));
const ZIP_UNICO = zipDe([novo]);
const ESCRITAS_NO_DISCO = ['gravar', 'remover', 'removerVariantes'];
const caminhoPng = (i) => `padrao/${i.sha256Padronizado}/mestre.png`;
const caminhoWebp = (i) => `padrao/${i.sha256Padronizado}/miniatura.webp`;

describe('[QTD-DB] pacote de 1 imagem sobre as 30 (PostgreSQL e armazenamento reais)', () => {
  let amb = null;
  let identidade = null;
  let raizes = [];
  const limparRaizes = () => { for (const raiz of raizes) removerTemporarioSeguro(raiz); raizes = []; };
  before(async () => {
    amb = await abrirAmbienteImagens();
    identidade = (await amb.q('SELECT current_database() AS banco, d.oid::text AS oid FROM pg_database d WHERE d.datname = current_database()')).rows[0];
  });
  after(async () => { limparRaizes(); if (amb) await amb.encerrar(); });

  /** Tabela vazia e armazenamento novo; `pacoteEm` grava um ZIP na pasta própria do caso. */
  async function ambiente() {
    limparRaizes();
    await amb.q('DELETE FROM imagens_padrao');
    const base = criarRaizTemporaria();
    raizes.push(base);
    const dirZip = path.join(base, 'pacotes');
    fs.mkdirSync(dirZip);
    const dirArm = path.join(base, 'armazenamento');
    const armazenamento = criarArmazenamentoImagens({ diretorio: dirArm });
    const pacoteEm = (nome, zip) => ({ nome, zip: h.gravarArquivo(dirZip, nome, zip), sha: h.sha256(zip) });
    return { dirArm, armazenamento, pacoteEm };
  }
  const importar = (a, p, extra = {}, { pool = amb.pool, armazenamento = a.armazenamento } = {}) => SERVICO().importarPacotePadrao(pool, {
    pacote: p.zip, pacoteSha256Esperado: p.sha, armazenamento, mapeamento: null, executar: true, destinoAutorizado: identidade, ...extra,
  });
  const estado = async (a) => ({ banco: await instantaneoDoBanco(amb.q), disco: instantaneoDoArmazenamento(a.dirArm) });
  async function comAsTrinta() {
    const a = await ambiente();
    const trinta = a.pacoteEm('Pacote_30.zip', ZIP_INTEGRO);
    const r = await importar(a, trinta);
    assert.deepEqual(r.resumo, { total: 30, novas: 30, existentes: 0, arquivosNovos: 60, arquivosPresentes: 0, sugestoes: 0 });
    return a;
  }
  async function recusa(promessa, codigo) {
    let erro = null;
    try { await promessa; } catch (e) { erro = e; }
    assert.notEqual(erro, null, 'a operação deveria ser recusada');
    assert.equal(erro.codigo, codigo, `${erro.codigo ?? erro.code}: ${erro.message}`);
    return erro;
  }

  test('QTD-DB-01 — a 31ª entra sobre as 30: 31 linhas e 62 arquivos; as 30 linhas (xmin e ctid) e os 60 arquivos anteriores ficam intactos', async () => {
    const a = await comAsTrinta();
    const antes = await estado(a);
    const unico = a.pacoteEm('Pacote_31.zip', ZIP_UNICO);

    const r = await importar(a, unico, { quantidadeEsperada: 1 });
    assert.equal(r.modo, 'EXECUCAO');
    assert.equal(r.verificados, 3);
    assert.deepEqual(r.resumo, { total: 1, novas: 1, existentes: 0, arquivosNovos: 2, arquivosPresentes: 0, sugestoes: 0 });
    assert.deepEqual(r.itens.map((i) => [i.nome, i.situacao]), [[NOME, 'NOVA']]);
    assert.match(r.itens[0].imagemId, /^[0-9]+$/);

    const depois = await estado(a);
    const depoisPorId = new Map(depois.banco.padrao.map((linha) => [linha.id, linha]));
    assert.equal(depoisPorId.size, 31);
    for (const linha of antes.banco.padrao) assert.deepEqual(depoisPorId.get(linha.id), linha, `linha ${linha.id} alterada`);
    for (const campo of ['sugestoes', 'materiais', 'contagens']) assert.deepEqual(depois.banco[campo], antes.banco[campo], campo);
    const nova = (await amb.q(
      'SELECT nome, arquivo_origem, sha256, sha256_miniatura, sha256_exibicao, sha256_original_ref, pacote_origem, pacote_sha256, formato, largura, altura, bytes_mestre, bytes_miniatura, bytes_exibicao, versao, ativo, ilustrativa FROM imagens_padrao WHERE sha256 = $1',
      [novo.sha256Padronizado],
    )).rows;
    assert.deepEqual(nova, [{
      nome: NOME, arquivo_origem: `${NOME}.png`, sha256: novo.sha256Padronizado, sha256_miniatura: novo.sha256Miniatura, sha256_exibicao: null, sha256_original_ref: novo.sha256Original,
      pacote_origem: 'Pacote_31.zip', pacote_sha256: unico.sha, formato: 'PNG', largura: 1024, altura: 1024, bytes_mestre: novo.bytesPadronizado, bytes_miniatura: novo.bytesMiniatura,
      bytes_exibicao: null, versao: 1, ativo: true, ilustrativa: true,
    }]);

    const antigos = antes.disco.filter((e) => e.caminho !== 'padrao');
    for (const e of antigos) assert.deepEqual(depois.disco.find((x) => x.caminho === e.caminho), e, `reescrito ou recriado: ${e.caminho}`);
    const esperados = [...pacote.itens.flatMap((i) => [caminhoPng(i), caminhoWebp(i)]), caminhoPng(novo), caminhoWebp(novo)].sort();
    assert.deepEqual(arquivosSob(a.dirArm), esperados, 'exatamente os 62 arquivos, sem sobra nem temporário');
    assert.ok(fs.readFileSync(path.join(a.dirArm, caminhoPng(novo))).equals(novo.padronizado));
    assert.ok(fs.readFileSync(path.join(a.dirArm, caminhoWebp(novo))).equals(novo.miniatura));
  });

  test('QTD-DB-02 — repetir a importação da 31ª não escreve nada: existente, zero instruções de escrita, zero gravações, banco e disco idênticos', async () => {
    const a = await comAsTrinta();
    const unico = a.pacoteEm('Pacote_31.zip', ZIP_UNICO);
    await importar(a, unico, { quantidadeEsperada: 1 });
    const antes = await estado(a);

    const e = { banco: espiarPool(amb.pool), disco: espiarObjeto(a.armazenamento) };
    const r = await importar(a, unico, { quantidadeEsperada: 1 }, { pool: e.banco.espiao, armazenamento: e.disco.espiao });
    assert.deepEqual(r.resumo, { total: 1, novas: 0, existentes: 1, arquivosNovos: 0, arquivosPresentes: 2, sugestoes: 0 });
    assert.deepEqual(e.banco.escritas(), []);
    assert.deepEqual(e.disco.registros.filter((x) => ESCRITAS_NO_DISCO.includes(x.metodo)), []);
    assert.deepEqual(await estado(a), antes);
  });

  test('QTD-DB-03 — a simulação (--dry-run) da 31ª não grava: NOVA sem imagemId, nenhum arquivo, banco e disco idênticos', async () => {
    const a = await comAsTrinta();
    const antes = await estado(a);
    const r = await importar(a, a.pacoteEm('Pacote_31.zip', ZIP_UNICO), { quantidadeEsperada: 1, executar: false });
    assert.equal(r.modo, 'SIMULACAO');
    assert.deepEqual(r.resumo, { total: 1, novas: 1, existentes: 0, arquivosNovos: 2, arquivosPresentes: 0, sugestoes: 0 });
    assert.deepEqual(r.itens, [{ nome: NOME, situacao: 'NOVA', imagemId: null }]);
    assert.deepEqual(await estado(a), antes);
  });

  test('QTD-DB-04 — sem a quantidade o pacote de uma imagem é recusado antes de qualquer acesso; o estado não muda', async () => {
    const a = await comAsTrinta();
    const antes = await estado(a);
    const e = { banco: espiarPool(amb.pool), disco: espiarObjeto(a.armazenamento) };
    const erro = await recusa(importar(a, a.pacoteEm('Pacote_31.zip', ZIP_UNICO), {}, { pool: e.banco.espiao, armazenamento: e.disco.espiao }), 'PACOTE_MANIFESTO_INVALIDO');
    assert.deepEqual(erro.detalhes, [{ campo: 'linhas', motivo: 'QUANTIDADE_DIFERENTE', esperado: 30, calculado: 1 }]);
    assert.deepEqual([e.banco.registros, e.disco.registros], [[], []]);
    assert.deepEqual(await estado(a), antes);
  });

  test('QTD-DB-05 — nome já usado por outra imagem é ESTADO_DIVERGENTE e nada é escrito; reimportar uma das 30 como pacote de uma imagem não grava nada', async () => {
    const a = await comAsTrinta();
    const antes = await estado(a);
    const mesmoNome = h.recomporItem(pacote.itens[3].nome, { original: h.originalFicticio('outro'), padronizado: h.pngFicticio({ semente: 'outro' }), miniatura: h.webpFicticio({ semente: 'outro' }) });
    const erro = await recusa(importar(a, a.pacoteEm('Nome_Usado.zip', zipDe([mesmoNome])), { quantidadeEsperada: 1 }), 'ESTADO_DIVERGENTE');
    assert.deepEqual(erro.detalhes, [{ nome: mesmoNome.nome, alvo: 'REGISTRO', campo: 'nome' }]);
    assert.deepEqual(await estado(a), antes);

    const r = await importar(a, a.pacoteEm('Ja_Existente.zip', zipDe([pacote.itens[0]])), { quantidadeEsperada: 1 });
    assert.deepEqual(r.resumo, { total: 1, novas: 0, existentes: 1, arquivosNovos: 0, arquivosPresentes: 2, sugestoes: 0 });
    assert.deepEqual(await estado(a), antes);
  });

  test('QTD-DB-06 — o pacote de uma imagem também entra numa biblioteca vazia: 1 linha e 2 arquivos', async () => {
    const a = await ambiente();
    const r = await importar(a, a.pacoteEm('Pacote_31.zip', ZIP_UNICO), { quantidadeEsperada: 1 });
    assert.deepEqual(r.resumo, { total: 1, novas: 1, existentes: 0, arquivosNovos: 2, arquivosPresentes: 0, sugestoes: 0 });
    assert.equal((await amb.q('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n, 1);
    assert.deepEqual(arquivosSob(a.dirArm), [caminhoPng(novo), caminhoWebp(novo)].sort());
  });

  test('QTD-DB-07 — pela linha de comando: --executar com quantidade 1 grava a 31ª (saída 0) e a simulação seguinte diz que não há nada a fazer', async () => {
    const a = await comAsTrinta();
    const unico = a.pacoteEm('Pacote_31.zip', ZIP_UNICO);
    const linhas = [];
    const saida = { log: (...p) => linhas.push(p.join(' ')), error: (...p) => linhas.push(p.join(' ')) };
    const comando = (modo) => CLI().executarComando({ pacote: unico.zip, sha256: unico.sha, mapeamento: null, modo, destino: identidade, quantidade: 1 }, { pool: amb.pool, armazenamento: a.armazenamento, saida });

    assert.equal((await comando('EXECUTAR')).saida, 0);
    const texto = linhas.join('\n');
    assert.match(texto, /Imagens: total=1 novas=1 existentes=0/);
    assert.match(texto, /Arquivos de imagem: novos=2 presentes=0/);
    assert.equal((await amb.q('SELECT count(*)::int AS n FROM imagens_padrao')).rows[0].n, 31);

    linhas.length = 0;
    assert.equal((await comando('SIMULAR')).saida, 0);
    assert.match(linhas.join('\n'), /Imagens: total=1 novas=0 existentes=1/);
  });
});
