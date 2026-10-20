'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const verificador = require('../../src/services/imagem-armazenamento-verificacao.service');
const a = require('../helpers/limpeza-orfaos');

/**
 * LIMPEZA DE ÓRFÃOS (Biblioteca de Imagens, P-ORF-01, fase RED): IDENTIFICAÇÃO SEGURA e SIMULAÇÃO (dry-run). Contrato geral e formato do relatório: ver
 * imagem-armazenamento-limpeza-politica.test.js.
 *
 * Princípios que estes testes fixam:
 *   - a simulação é o PADRÃO e é somente leitura (banco: uma transação READ ONLY; disco: só lstat, readdir, realpath e open) e enumera EXATAMENTE o que o verificador
 *     existente classifica como ORFAO, fora de "recente", no escopo das empresas (nunca inventa um critério próprio);
 *   - só vira candidato: conjunto sem registro (ORFAO_CONJUNTO), variante sem registro numa pasta registrada (ORFAO_VARIANTE) e temporário de gravação (TEMPORARIO_RESIDUAL);
 *   - a biblioteca PADRÃO nunca é candidata (relatada em foraDoEscopo); entrada estranha, link simbólico, empresa inexistente, registro com arquivo ausente e banco que não
 *     parece o certo tornam o armazenamento NÃO CONFIÁVEL: impedem a execução (ARMAZENAMENTO_NAO_CONFIAVEL) e nada daquilo vira candidato;
 *   - o relatório sai ordenado (empresa, hash, tipo, primeiro arquivo) e nunca leva caminho absoluto nem caractere de controle.
 */

const { AGORA, DIA, h } = a;
const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };

const S = () => exigirModulo('src/services/imagem-armazenamento-limpeza.service');
const mundo = (opcoes) => a.criarMundo(novaRaiz, opcoes);
const rodar = (m, extra = {}) => S().limparOrfaos(m.banco, { diretorio: m.raiz, fs: m.fs, agora: () => AGORA, ...extra });
const comJanela = (m) => ({ janela: { arquivo: m.arquivoDaJanela } });

const ORDEM_DO_TIPO = { ORFAO_CONJUNTO: 0, ORFAO_VARIANTE: 1, TEMPORARIO_RESIDUAL: 2 };
const comparar = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const ordemDoRelatorio = (x, y) => (x.empresaId - y.empresaId) || comparar(x.hash, y.hash) || (ORDEM_DO_TIPO[x.tipo] - ORDEM_DO_TIPO[y.tipo]) || comparar(x.arquivos[0] ?? '', y.arquivos[0] ?? '');
const bytesDo = (orfao) => Object.values(orfao.conteudos).reduce((soma, c) => soma + c.length, 0);
const candidatoEsperado = (orfao, idadeMinutos, extra = {}) => ({
  escopo: 'EMPRESA', empresaId: orfao.empresaId, hash: orfao.hash, tipo: 'ORFAO_CONJUNTO', arquivos: Object.keys(orfao.conteudos).sort(), bytes: bytesDo(orfao), idadeMinutos, ...extra,
});

describe('[IDN] o que é candidato', () => {
  test('IDN-01 — a simulação lista EXATAMENTE os candidatos (órfão antigo, pasta vazia, temporário antigo) e separa os retidos (órfão e temporário recentes), sem alterar nada', async () => {
    const m = mundo({ orfaos: [
      { semente: 'i1-antigo', idadeMin: 3 * DIA }, { semente: 'i1-vazio', idadeMin: 2 * DIA, variantes: [] }, { semente: 'i1-recente', idadeMin: 5 }, { semente: 'i1-velho', idadeMin: 10 * DIA },
    ] });
    const [antigo, vazio, recente, velho] = m.orfaos;
    const tmpAntigo = a.criarTemporario(m.raiz, { hash: m.registradas[0].shaEnvio, nome: 'mestre.png', idadeMin: 3 * DIA });
    const tmpNovo = a.criarTemporario(m.raiz, { hash: m.registradas[0].shaEnvio, nome: 'exibicao.webp', idadeMin: 10 });
    const antes = m.retrato();
    const r = await rodar(m);
    const tmp = (t, idadeMinutos) => ({ escopo: 'EMPRESA', empresaId: 7, hash: m.registradas[0].shaEnvio, tipo: 'TEMPORARIO_RESIDUAL', arquivos: [t.nome], bytes: 'gravacao-interrompida'.length, idadeMinutos });
    const esperadosCandidatos = [
      candidatoEsperado(antigo, 3 * DIA), candidatoEsperado(vazio, 2 * DIA, { arquivos: [], bytes: 0 }), candidatoEsperado(velho, 10 * DIA), tmp(tmpAntigo, 3 * DIA),
    ].sort(ordemDoRelatorio);
    assert.deepEqual(r.candidatos, esperadosCandidatos);
    assert.deepEqual(r.retidos, [candidatoEsperado(recente, 5), tmp(tmpNovo, 10)].sort(ordemDoRelatorio));
    assert.deepEqual(r.foraDoEscopo, []);
    assert.equal(r.veredito, 'ORFAO');
    assert.deepEqual(r.resumo, { candidatos: 4, retidos: 2, foraDoEscopo: 0, removidos: 0, ignorados: 0, falhas: 0, restantes: 0, bytesLiberados: 0 });
    assert.deepEqual(m.destrutivas(), []);
    assert.deepEqual(m.retrato(), antes);
  });

  test('IDN-02 — os candidatos são IGUAIS ao que o verificador existente classifica como ORFAO, fora de "recente", nas empresas (nenhum critério paralelo)', async () => {
    const m = mundo({ orfaos: [
      { semente: 'i2-a', idadeMin: 3 * DIA }, { semente: 'i2-b', idadeMin: 40 * DIA }, { semente: 'i2-c', idadeMin: 1500 }, { semente: 'i2-d', idadeMin: 1499 }, { semente: 'i2-e', idadeMin: 9 * DIA, variantes: [] },
    ] });
    a.criarTemporario(m.raiz, { hash: m.registradas[0].shaEnvio, nome: 'miniatura.webp', idadeMin: 2 * DIA });
    const extra = path.join(m.raiz, m.registradas[0].pasta, 'mestre.jpg');
    fs.writeFileSync(extra, 'extra');
    a.envelhecer(extra, 4 * DIA);
    const r = await rodar(m);
    const independente = a.criarBancoDeLimpeza({ empresas: [7], empresa: m.registradas.map((i) => i.linha) });
    // 1500 = retenção padrão da limpeza (o padrão do verificador é 1440): o verificador independente recebe o mesmo limiar.
    const doVerificador = (await verificador.verificarArmazenamento(independente, { diretorio: m.raiz, agora: () => AGORA, idadeMinimaOrfaoMinutos: 1500 }))
      .armazenamento.filter((s) => s.classe === 'ORFAO' && !s.recente && s.escopo === 'EMPRESA')
      .map(({ empresaId, hash, tipo, arquivos, bytes, idadeMinutos }) => ({ empresaId, hash, tipo, arquivos, bytes, idadeMinutos }))
      .sort(ordemDoRelatorio);
    assert.equal(doVerificador.length, 6, 'o cenário tem 4 conjuntos, 1 temporário e 1 variante extra elegíveis');
    assert.deepEqual(r.candidatos.map(({ escopo, ...resto }) => resto), doVerificador);
  });

  test('IDN-03 — a idade do conjunto é a do arquivo MAIS NOVO: com um arquivo antigo e outro de 5 minutos o conjunto fica RETIDO (idade 5)', async () => {
    const m = mundo({ orfaos: [{ semente: 'i3', idadeMin: 3 * DIA }] });
    a.envelhecer(m.orfaos[0].caminhos['miniatura.webp'], 5);
    const r = await rodar(m);
    assert.deepEqual(r.candidatos, []);
    assert.deepEqual(r.retidos.map((c) => [c.hash, c.idadeMinutos]), [[m.orfaos[0].hash, 5]]);
  });

  test('IDN-04 — pasta SEM registro que só tem um temporário antigo: o candidato é o temporário (TEMPORARIO_RESIDUAL), nunca um "conjunto"', async () => {
    const m = mundo();
    const hash = h.hex64('i4-pasta-so-com-temporario');
    const tmp = a.criarTemporario(m.raiz, { hash, nome: 'mestre.png', idadeMin: 3 * DIA });
    const r = await rodar(m);
    assert.deepEqual(r.candidatos.map((c) => [c.tipo, c.hash, c.arquivos]), [['TEMPORARIO_RESIDUAL', hash, [tmp.nome]]]);
  });

  test('IDN-05 — variante extra numa pasta de imagem REGISTRADA (ORFAO_VARIANTE): só ela é candidata; os arquivos esperados do registro nunca aparecem', async () => {
    const m = mundo();
    const reg = m.registradas[0];
    const extra = path.join(m.raiz, reg.pasta, 'mestre.jpg');
    fs.writeFileSync(extra, 'extra-de-outro-formato');
    a.envelhecer(extra, 3 * DIA);
    const r = await rodar(m);
    assert.deepEqual(r.candidatos.map((c) => [c.tipo, c.hash, c.arquivos]), [['ORFAO_VARIANTE', reg.shaEnvio, ['mestre.jpg']]]);
    for (const c of r.candidatos) for (const nome of c.arquivos) assert.equal(Object.values(reg.chaves).some((chave) => chave.endsWith(`/${nome}`)), false);
  });

  test('IDN-06 — a biblioteca PADRÃO nunca é candidata: o órfão do escopo padrão (antigo ou recente) vai para foraDoEscopo, e nenhuma trava ou remoção é tentada para ele', async () => {
    const m = mundo({ orfaos: [{ semente: 'i6-padrao-antigo', escopo: 'PADRAO', idadeMin: 3 * DIA }, { semente: 'i6-padrao-novo', escopo: 'PADRAO', idadeMin: 5 }] });
    const r = await rodar(m, { executar: false });
    assert.deepEqual(r.candidatos, []);
    assert.deepEqual(r.foraDoEscopo.map((c) => [c.escopo, c.hash, c.tipo]).sort(), m.orfaos.map((o) => ['PADRAO', o.hash, 'ORFAO_CONJUNTO']).sort());
    assert.equal(r.foraDoEscopo.every((c) => c.empresaId === null), true);
    assert.equal(r.resumo.foraDoEscopo, 2);
    assert.equal(m.banco.eventos.some((e) => e.tipo === 'TRAVA'), false);
  });

  test('IDN-07 — isolamento por empresa: o MESMO hash registrado na empresa 7 e solto (sem registro) na empresa 8 faz candidata SÓ a pasta da empresa 8', async () => {
    const m = mundo({ empresas: [7, 8] });
    const orfaoDaOutra = a.criarOrfao(m.raiz, { empresaId: 8, semente: 'i7', hash: m.registradas[0].shaEnvio, idadeMin: 3 * DIA });
    const r = await rodar(m);
    assert.deepEqual(r.candidatos.map((c) => [c.empresaId, c.hash]), [[8, m.registradas[0].shaEnvio]]);
    assert.equal(orfaoDaOutra.hash, m.registradas[0].shaEnvio);
    assert.equal(r.candidatos.some((c) => c.empresaId === 7), false, 'a pasta registrada da empresa 7 não é candidata');
  });

  test('IDN-08 — a ordem do relatório é determinística (empresa, hash, tipo, primeiro arquivo) e não depende da ordem do sistema de arquivos', async () => {
    const opcoes = [];
    for (const empresaId of [8, 7]) for (const semente of ['z', 'm', 'a']) opcoes.push({ empresaId, semente: `i8-${empresaId}-${semente}`, idadeMin: 3 * DIA });
    const normal = mundo({ empresas: [7, 8], orfaos: opcoes });
    const invertida = mundo({ empresas: [7, 8], orfaos: opcoes, inverterListagens: true });
    const r1 = await rodar(normal);
    const r2 = await rodar(invertida);
    const chaves = (r) => r.candidatos.map((c) => [c.empresaId, c.hash]);
    assert.deepEqual(chaves(r1), [...chaves(r1)].sort((x, y) => (x[0] - y[0]) || comparar(x[1], y[1])));
    assert.equal(r1.candidatos.length, 6);
    assert.deepEqual(chaves(r2), chaves(r1), 'a listagem invertida do disco dá o mesmo relatório');
  });
});

describe('[IDN] o que NÃO é confiável: impede a execução e nunca vira candidato', () => {
  const nuncaCandidato = (r, hash) => assert.equal(r.candidatos.some((c) => c.hash === hash), false);
  const naoConfiavel = (r) => {
    assert.equal(r.veredito, 'INVESTIGAR');
    assert.equal(r.impedimentos.includes('ARMAZENAMENTO_NAO_CONFIAVEL'), true);
    assert.equal(r.executavel, false);
  };

  test('IDN-09 — entradas estranhas (arquivo solto na raiz, na pasta da empresa, ".DS_Store" ou subpasta dentro do órfão, pasta com nome que não é hash): armazenamento NÃO confiável, nada é tocado', async () => {
    const montagens = {
      'arquivo solto na raiz': (m) => fs.writeFileSync(path.join(m.raiz, 'LEIAME.txt'), 'x'),
      'arquivo solto na pasta da empresa': (m) => fs.writeFileSync(path.join(m.raiz, '7', 'solto.txt'), 'x'),
      '.DS_Store dentro do órfão': (m) => fs.writeFileSync(path.join(m.orfaos[0].pasta, '.DS_Store'), 'x'),
      'subpasta dentro do órfão': (m) => fs.mkdirSync(path.join(m.orfaos[0].pasta, 'subpasta')),
      'pasta de empresa com nome que não é hash': (m) => fs.mkdirSync(path.join(m.raiz, '7', 'nao-e-hash')),
    };
    for (const [rotulo, montar] of Object.entries(montagens)) {
      const m = mundo({ orfaos: [{ semente: `i9-${rotulo.length}`, idadeMin: 3 * DIA }] });
      montar(m);
      const antes = m.retrato();
      const r = await rodar(m);
      naoConfiavel(r);
      assert.deepEqual(m.destrutivas(), [], rotulo);
      assert.deepEqual(m.retrato(), antes, rotulo);
    }
  });

  test('IDN-10 — link simbólico (variante que é link para fora, pasta que é link): armazenamento NÃO confiável; o alvo do link nunca é lido como candidato nem tocado', async () => {
    const alheia = novaRaiz();
    const alvo = path.join(alheia, 'segredo.txt');
    fs.writeFileSync(alvo, 'conteudo-que-nao-pode-ser-tocado');
    const m = mundo({ orfaos: [{ semente: 'i10', idadeMin: 3 * DIA, variantes: ['mestre.png', 'miniatura.webp'] }] });
    fs.symlinkSync(alvo, path.join(m.orfaos[0].pasta, 'exibicao.webp'));
    const pastaLink = path.join(m.raiz, '7', h.hex64('i10-pasta-link'));
    fs.symlinkSync(alheia, pastaLink);
    const antes = m.retrato();
    const r = await rodar(m);
    naoConfiavel(r);
    assert.equal(fs.readFileSync(alvo, 'utf8'), 'conteudo-que-nao-pode-ser-tocado');
    assert.equal(fs.lstatSync(path.join(m.orfaos[0].pasta, 'exibicao.webp')).isSymbolicLink(), true);
    assert.deepEqual(m.retrato(), antes);
    assert.deepEqual(m.destrutivas(), []);
  });

  test('IDN-11 — pasta de EMPRESA INEXISTENTE no banco (arquivos de quem não existe): não é sobra comum, não é candidata e torna o armazenamento não confiável', async () => {
    const m = mundo({ orfaos: [{ semente: 'i11-fantasma', empresaId: 99, idadeMin: 30 * DIA }] });
    const r = await rodar(m);
    naoConfiavel(r);
    nuncaCandidato(r, m.orfaos[0].hash);
  });

  test('IDN-12 — registro com arquivo AUSENTE (RECUPERAVEL): armazenamento não confiável; os arquivos que sobraram dessa imagem nunca são candidatos', async () => {
    const m = mundo({ registradas: 0, orfaos: [{ semente: 'i12-orfao', idadeMin: 3 * DIA }] });
    const incompleta = h.criarImagemEmpresa(m.raiz, { id: 5, empresaId: 7, semente: 'i12-incompleta', agora: AGORA, ausentes: ['miniatura'] });
    const integra = h.criarImagemEmpresa(m.raiz, { id: 6, empresaId: 7, semente: 'i12-integra', agora: AGORA });
    m.banco.registro.push(incompleta.linha, integra.linha);
    const r = await rodar(m);
    assert.equal(r.veredito, 'RECUPERAVEL');
    assert.equal(r.impedimentos.includes('ARMAZENAMENTO_NAO_CONFIAVEL'), true);
    assert.equal(r.executavel, false);
    nuncaCandidato(r, incompleta.shaEnvio);
    nuncaCandidato(r, integra.shaEnvio);
    assert.deepEqual(r.candidatos.map((c) => c.hash), [m.orfaos[0].hash], 'a simulação só INFORMA: o órfão legítimo é listado, mas a execução não é permitida');
  });

  test('IDN-13 — banco que NÃO parece o certo (sem nenhum registro, com órfãos antigos no disco): alerta BANCO_SEM_REGISTROS_COM_ARQUIVOS, NÃO confiável, e nenhum candidato deve ser tratado como removível', async () => {
    const m = mundo({ registradas: 0, orfaos: [{ semente: 'i13-a', idadeMin: 3 * DIA }, { semente: 'i13-b', idadeMin: 9 * DIA }] });
    const r = await rodar(m);
    naoConfiavel(r);
    assert.deepEqual(r.alertas, ['BANCO_SEM_REGISTROS_COM_ARQUIVOS']);
  });

  test('IDN-14 — armazenamento que não é o deste banco (nenhum arquivo esperado existe): alerta NENHUM_ARQUIVO_ESPERADO_PRESENTE e não confiável', async () => {
    const m = mundo({ registradas: 0, orfaos: [{ semente: 'i14', idadeMin: 3 * DIA }] });
    const nunca = h.criarImagemEmpresa(m.raiz, { id: 9, empresaId: 7, semente: 'i14-nunca', agora: AGORA, ausentes: ['mestre', 'exibicao', 'miniatura'] });
    m.banco.registro.push(nunca.linha);
    const r = await rodar(m);
    naoConfiavel(r);
    assert.equal(r.alertas.includes('NENHUM_ARQUIVO_ESPERADO_PRESENTE'), true);
  });

  test('IDN-15 — raiz ausente ou que não é diretório: alerta (RAIZ_AUSENTE / RAIZ_INVALIDA), não confiável, e a raiz NUNCA é criada, nem na simulação nem na execução', async () => {
    const pai = novaRaiz();
    const ausente = path.join(pai, 'imagens-que-nao-existem');
    const ehArquivo = path.join(pai, 'imagens-arquivo');
    fs.writeFileSync(ehArquivo, 'x');
    const banco = () => a.criarBancoDeLimpeza({ empresas: [7] });
    const { limparOrfaos } = S();
    for (const [diretorio, alerta] of [[ausente, 'RAIZ_AUSENTE'], [ehArquivo, 'RAIZ_INVALIDA']]) {
      const antes = fs.readdirSync(pai).sort();
      const r = await limparOrfaos(banco(), { diretorio, fs: a.fachadaDeLimpeza(pai).fs, agora: () => AGORA });
      naoConfiavel(r);
      assert.deepEqual(r.alertas, [alerta]);
      assert.deepEqual(r.candidatos, []);
      assert.deepEqual(fs.readdirSync(pai).sort(), antes, 'nada foi criado');
    }
    assert.equal(fs.existsSync(ausente), false);
  });

  test('IDN-16 — o relatório nunca leva caminho absoluto nem caractere de controle, mesmo com nomes hostis no disco', async () => {
    const m = mundo({ orfaos: [{ semente: 'i16', idadeMin: 3 * DIA }] });
    fs.writeFileSync(path.join(m.raiz, '\u001b[2J\u001b[31mapaga-tudo'), 'x');
    fs.writeFileSync(path.join(m.raiz, 'linha1\nlinha2'), 'x');
    const r = await rodar(m);
    const texto = JSON.stringify(r);
    assert.equal(a.saidaLimpa(texto, m.raiz), true);
    assert.equal(texto.includes(m.pastaDaTrava), false);
    // O JSON escapa os caracteres de controle por si só; o que prova o contrato é que os nomes hostis do disco NÃO entram no relatório da limpeza (quem os descreve é o verificador).
    assert.equal(texto.includes('apaga-tudo'), false);
    assert.equal(texto.includes('linha2'), false);
    assert.equal(r.impedimentos.includes('ARMAZENAMENTO_NAO_CONFIAVEL'), true, 'e as entradas estranhas tornam o armazenamento não confiável');
  });
});

describe('[DRY] a simulação é o padrão e é somente leitura', () => {
  test('DRY-01 — sem `executar`, o modo é SIMULACAO: nenhuma operação destrutiva, árvore idêntica, e duas simulações seguidas dão o MESMO relatório', async () => {
    const m = mundo({ orfaos: [{ semente: 'd1-a', idadeMin: 3 * DIA }, { semente: 'd1-b', idadeMin: 5 }] });
    const antes = m.retrato();
    const r1 = await rodar(m);
    const r2 = await rodar(m);
    assert.equal(r1.modo, 'SIMULACAO');
    assert.deepEqual(m.destrutivas(), []);
    assert.deepEqual(m.retrato(), antes);
    assert.deepEqual(r2, r1);
    assert.equal(r1.removidos.length, 0);
  });

  test('DRY-02 — no banco a simulação só LÊ: transação READ ONLY, nenhum INSERT/UPDATE/DELETE/COMMIT, nenhuma trava, toda conexão devolvida', async () => {
    const m = mundo({ orfaos: [{ semente: 'd2', idadeMin: 3 * DIA }] });
    await rodar(m);
    assert.ok(m.banco.contadores.conexoes >= 1);
    assert.equal(m.banco.contadores.conexoes, m.banco.contadores.liberacoes, 'toda conexão foi devolvida');
    assert.equal(m.banco.eventos.filter((e) => e.tipo === 'BEGIN').every((e) => /READ ONLY/i.test(e.sql)), true);
    for (const sql of m.banco.sql) assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP|COMMIT)\b/i);
    assert.equal(m.banco.eventos.some((e) => e.tipo === 'TRAVA'), false, 'simular não toma a trava da biblioteca');
  });

  test('DRY-03 — só LÊ a janela: livre não é criada; com BACKUP em andamento (ou outra limpeza) é relatada como OCUPADA, a trava fica byte a byte intacta e os candidatos continuam listados', async () => {
    const livre = mundo({ orfaos: [{ semente: 'd3-livre', idadeMin: 3 * DIA }] });
    const rLivre = await rodar(livre, { intervaloBackupMinutos: 60, ...comJanela(livre) });
    assert.deepEqual(rLivre.janela, { configurada: true, estado: 'LIVRE', dono: null });
    assert.equal(fs.existsSync(livre.arquivoDaJanela), false);

    for (const tipo of ['BACKUP', 'LIMPEZA']) {
      const m = mundo({ orfaos: [{ semente: `d3-${tipo}`, idadeMin: 3 * DIA }] });
      const doc = a.escreverTravaAlheia(m.arquivoDaJanela, { tipo, pid: 31337 });
      const antes = fs.readFileSync(m.arquivoDaJanela);
      const r = await rodar(m, { intervaloBackupMinutos: 60, ...comJanela(m) });
      assert.deepEqual(r.janela, { configurada: true, estado: 'OCUPADA', dono: { tipo, pid: 31337, iniciadoEm: doc.iniciadoEm } });
      assert.deepEqual(r.impedimentos, ['JANELA_OCUPADA']);
      assert.equal(r.executavel, false);
      assert.equal(r.recusa, null, 'simular não é recusado: só informa');
      assert.equal(r.candidatos.length, 1);
      assert.deepEqual(fs.readFileSync(m.arquivoDaJanela), antes);
    }
  });

  test('DRY-04 — janela com caminho inválido ou DENTRO do armazenamento: a simulação não quebra e aponta JANELA_INVALIDA (a execução seria recusada), sem criar nada', async () => {
    const m = mundo({ orfaos: [{ semente: 'd4', idadeMin: 3 * DIA }] });
    for (const arquivo of ['janela-relativa.lock', path.join(m.raiz, 'janela.lock')]) {
      const antes = m.retrato();
      const r = await rodar(m, { intervaloBackupMinutos: 60, janela: { arquivo } });
      assert.deepEqual(r.impedimentos, ['JANELA_INVALIDA'], arquivo);
      assert.equal(r.janela.estado, 'INVALIDA');
      assert.equal(r.executavel, false);
      assert.deepEqual(m.retrato(), antes);
    }
  });

  test('DRY-05 — `limite` só vale para a execução: a simulação lista TODOS os candidatos e informa restantes 0', async () => {
    const m = mundo({ orfaos: Array.from({ length: 5 }, (_, i) => ({ semente: `d5-${i}`, idadeMin: 3 * DIA })) });
    const r = await rodar(m, { limite: 2 });
    assert.equal(r.candidatos.length, 5);
    assert.equal(r.restantes, 0);
    assert.equal(r.limite, 2);
  });

  test('DRY-06 — na simulação nenhum gancho de remoção é chamado; só `aposPlanejar`, uma vez, com o relatório do plano', async () => {
    const m = mundo({ orfaos: [{ semente: 'd6', idadeMin: 3 * DIA }] });
    const chamados = [];
    const ganchos = {
      aposPlanejar: async (plano) => { chamados.push(['aposPlanejar', plano.candidatos.length]); },
      aposTravar: async () => { chamados.push(['aposTravar']); },
      antesDeRemover: async () => { chamados.push(['antesDeRemover']); },
      aposRemover: async () => { chamados.push(['aposRemover']); },
    };
    await rodar(m, { ganchos });
    assert.deepEqual(chamados, [['aposPlanejar', 1]]);
  });

  test('DRY-07 — a simulação funciona com a fachada de arquivos SÓ de leitura do verificador (nenhuma outra operação é necessária)', async () => {
    const m = mundo({ orfaos: [{ semente: 'd7', idadeMin: 3 * DIA }] });
    const soLeitura = h.fachadaDeLeitura(m.raiz);
    const r = await S().limparOrfaos(m.banco, { diretorio: m.raiz, fs: soLeitura.fs, agora: () => AGORA });
    assert.equal(r.candidatos.length, 1);
    assert.equal(soLeitura.chamadas.every((c) => ['lstat', 'readdir', 'realpath', 'open', 'stat', 'read', 'close'].includes(c.metodo)), true);
    assert.deepEqual(soLeitura.abertos.size, 0, 'nenhum arquivo ficou aberto');
  });

  test('DRY-08 — uma trava de janela ILEGÍVEL (lixo no lugar do documento) conta como janela OCUPADA com dono desconhecido: a simulação não quebra, informa JANELA_OCUPADA e deixa o arquivo como está', async () => {
    for (const conteudo of ['lixo qualquer', '{"outra":"coisa"}', '']) {
      const m = mundo({ orfaos: [{ semente: `d8-${conteudo.length}`, idadeMin: 3 * DIA }] });
      fs.writeFileSync(m.arquivoDaJanela, conteudo, { mode: 0o600 });
      const r = await rodar(m, { intervaloBackupMinutos: 60, ...comJanela(m) });
      assert.deepEqual(r.janela, { configurada: true, estado: 'OCUPADA', dono: null }, JSON.stringify(conteudo));
      assert.deepEqual(r.impedimentos, ['JANELA_OCUPADA']);
      assert.equal(r.recusa, null);
      assert.equal(r.candidatos.length, 1);
      assert.equal(fs.readFileSync(m.arquivoDaJanela, 'utf8'), conteudo);
    }
  });
});
