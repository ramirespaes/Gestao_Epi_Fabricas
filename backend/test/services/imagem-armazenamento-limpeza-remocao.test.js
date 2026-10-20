'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarRaizTemporaria, removerTemporarioSeguro } = require('../storage/helpers/tmp-seguro');
const verificador = require('../../src/services/imagem-armazenamento-verificacao.service');
const { lockDaBiblioteca } = require('../../src/utils/lock-biblioteca-imagens');
const a = require('../helpers/limpeza-orfaos');

/**
 * LIMPEZA DE ÓRFÃOS (Biblioteca de Imagens, P-ORF-01, fase RED): REMOÇÃO, PROTEÇÃO DE IMAGENS EM USO e EXCLUSÃO MÚTUA COM BACKUP, no nível do serviço. Contrato geral e
 * formato do relatório: ver imagem-armazenamento-limpeza-politica.test.js.
 *
 * Como a execução trabalha (decisão D-C3 do Documento 56, "reconferência sob a trava"; Documento 65, seção 7.2):
 *   1. adquire a TRAVA DE JANELA (src/utils/janela-escrita-imagens.js, tipo LIMPEZA) ANTES de ler qualquer coisa e a solta DEPOIS do último commit, em qualquer desfecho;
 *   2. planeja pelo verificador (uma transação READ ONLY REPEATABLE READ); se o armazenamento não for confiável (veredito RECUPERAVEL/INVESTIGAR ou alerta), RECUSA;
 *   3. para cada candidato, em ordem fixa e até `limite`: UMA transação READ ONLY que toma a MESMA trava da biblioteca da empresa que o envio usa (lockDaBiblioteca),
 *      relê o registro por (empresa, SHA-256), relê o disco (idade e entradas) e SÓ ENTÃO remove (unlink dos arquivos validados, depois rmdir se vazio e sem registro),
 *      ainda sob a trava; a transação termina depois da remoção. A limpeza NUNCA escreve no banco;
 *   4. o que mudou depois do plano é ignorado com motivo (REGISTRO_APARECEU, MAIS_NOVO_QUE_A_RETENCAO, ENTRADA_ESTRANHA, JA_REMOVIDO, TRAVA_OCUPADA); uma falha ao remover
 *      isola o conjunto (falhas) e a execução segue; nunca se remove arquivo de registro, de empresa de outro registro, da biblioteca padrão, link, nome estranho ou diretório.
 */

const { AGORA, DIA, h } = a;
const raizes = [];
after(() => { for (const raiz of raizes) removerTemporarioSeguro(raiz); });
const novaRaiz = () => { const raiz = criarRaizTemporaria(); raizes.push(raiz); return raiz; };

const S = () => exigirModulo('src/services/imagem-armazenamento-limpeza.service');
const mundo = (opcoes) => a.criarMundo(novaRaiz, opcoes);
const rodar = (m, extra = {}) => S().limparOrfaos(m.banco, { diretorio: m.raiz, fs: m.fs, agora: () => AGORA, ...extra });
const comJanela = (m) => ({ janela: { arquivo: m.arquivoDaJanela } });
/** Execução completa e válida: intervalo de backup de 1 h, retenção padrão de 1.500 min, janela configurada. */
const executar = (m, extra = {}) => rodar(m, { executar: true, intervaloBackupMinutos: 60, ...comJanela(m), ...extra });

const comparar = (x, y) => (x < y ? -1 : x > y ? 1 : 0);
const NOMES_DO_CONJUNTO = ['exibicao.webp', 'mestre.png', 'miniatura.webp'];
const arquivosRemovidos = (orfao) => NOMES_DO_CONJUNTO.map((nome) => ({ nome, bytes: orfao.conteudos[nome].length, sha256: h.sha(orfao.conteudos[nome]) }));
const removidoEsperado = (orfao, extra = {}) => ({ empresaId: orfao.empresaId, hash: orfao.hash, tipo: 'ORFAO_CONJUNTO', arquivos: arquivosRemovidos(orfao), pastaRemovida: true, ...extra });
const porHash = (x, y) => comparar(x.hash, y.hash);
const hashes = (lista) => lista.map((x) => x.hash);

/**
 * Uma transação por segmento da linha do tempo: do BEGIN até o PRÓXIMO BEGIN (ou o fim), de modo que nada que aconteça depois do COMMIT/ROLLBACK escape da conferência.
 * `tipos` são os tipos de evento do segmento; `fim` é a posição do primeiro COMMIT/ROLLBACK dentro dele (-1 se a transação nunca terminou). O primeiro segmento é o
 * instantâneo do verificador; os demais, um por candidato.
 */
function transacoes(eventos) {
  const segmentos = [];
  let atual = null;
  for (const e of eventos) {
    if (e.tipo === 'BEGIN') { atual = { eventos: [e] }; segmentos.push(atual); } else if (atual) atual.eventos.push(e);
  }
  for (const segmento of segmentos) {
    segmento.tipos = segmento.eventos.map((e) => e.tipo);
    segmento.fim = segmento.tipos.findIndex((tipo) => tipo === 'COMMIT' || tipo === 'ROLLBACK');
    segmento.somenteLeitura = /READ ONLY/i.test(segmento.eventos[0].sql) || segmento.eventos.some((e) => e.tipo === 'CONFIG' && /READ ONLY/i.test(e.sql));
  }
  return segmentos;
}
const PASTA_DE_UMA_IMAGEM = /^[1-9][0-9]*\/[0-9a-f]{64}$/;
const ARQUIVO_VALIDADO = /^[1-9][0-9]*\/[0-9a-f]{64}\/(?:mestre\.(?:png|jpg|webp)|(?:exibicao|miniatura)\.webp)(?:\.[0-9a-f]{16}\.tmp)?$/;

describe('[REM] a execução remove só o planejado e relata cada arquivo', () => {
  test('REM-01 — remove EXATAMENTE os conjuntos candidatos (os antigos), poupa o retido e a imagem registrada, relata cada arquivo com tamanho e SHA-256, e o verificador depois enxerga o armazenamento íntegro', async () => {
    const m = mundo({ orfaos: [{ semente: 'r1-a', idadeMin: 3 * DIA }, { semente: 'r1-b', idadeMin: 10 * DIA }, { semente: 'r1-recente', idadeMin: 5 }] });
    const [a1, b1, recente] = m.orfaos;
    const registradaAntes = h.retratoDaArvore(path.join(m.raiz, m.registradas[0].pasta));
    const r = await executar(m);
    assert.equal(r.modo, 'EXECUCAO');
    assert.equal(r.recusa, null);
    assert.deepEqual(r.removidos, [removidoEsperado(a1), removidoEsperado(b1)].sort(porHash));
    assert.equal(a1.existe() || b1.existe(), false);
    assert.equal(recente.existe(), true, 'o recente fica');
    assert.deepEqual(h.retratoDaArvore(path.join(m.raiz, m.registradas[0].pasta)), registradaAntes, 'a imagem registrada não muda');
    assert.deepEqual(r.resumo, { candidatos: 2, retidos: 1, foraDoEscopo: 0, removidos: 2, ignorados: 0, falhas: 0, restantes: 0, bytesLiberados: 2 * (300 + 120 + 120) });
    const depois = await verificador.verificarArmazenamento(a.criarBancoDeLimpeza({ empresas: [7], empresa: m.registradas.map((i) => i.linha) }), { diretorio: m.raiz, agora: () => AGORA });
    assert.equal(depois.veredito, 'INTEGRO');
    assert.deepEqual(depois.armazenamento.filter((s) => !s.recente), []);
  });

  test('REM-02 — executar de novo não faz nada (idempotente): sem candidatos, nada removido, árvore igual à do fim da primeira execução', async () => {
    const m = mundo({ orfaos: [{ semente: 'r2', idadeMin: 3 * DIA }] });
    const primeira = await executar(m);
    assert.deepEqual(hashes(primeira.removidos), [m.orfaos[0].hash], 'a primeira execução removeu o órfão: sem isso a repetição passaria por ausência de operações');
    assert.equal(m.orfaos[0].existe(), false);
    const aposPrimeira = m.retrato();
    const destrutivasAntes = m.destrutivas().length;
    assert.ok(destrutivasAntes > 0, 'a primeira execução apagou de fato');
    const r = await executar(m);
    assert.deepEqual([r.candidatos, r.removidos, r.ignorados, r.falhas], [[], [], [], []]);
    assert.equal(m.destrutivas().length, destrutivasAntes, 'nenhuma operação destrutiva nova');
    assert.deepEqual(m.retrato(), aposPrimeira);
  });

  test('REM-03 — pasta de órfão VAZIA é removida só com rmdir (nenhum unlink)', async () => {
    const m = mundo({ orfaos: [{ semente: 'r3', idadeMin: 3 * DIA, variantes: [] }] });
    const r = await executar(m);
    assert.deepEqual(m.destrutivas().map((c) => [c.metodo, c.rel]), [['rmdir', m.orfaos[0].relPasta]]);
    assert.deepEqual(r.removidos, [{ empresaId: 7, hash: m.orfaos[0].hash, tipo: 'ORFAO_CONJUNTO', arquivos: [], pastaRemovida: true }]);
    assert.equal(m.orfaos[0].existe(), false);
  });

  test('REM-04 — temporário antigo em pasta REGISTRADA: só o temporário sai; os arquivos da imagem e a pasta ficam (pastaRemovida falso)', async () => {
    const m = mundo();
    const reg = m.registradas[0];
    const tmp = a.criarTemporario(m.raiz, { hash: reg.shaEnvio, nome: 'mestre.png', idadeMin: 3 * DIA });
    const doDisco = () => ['mestre', 'exibicao', 'miniatura'].map((variante) => h.sha(fs.readFileSync(reg.caminho(variante))));
    const antesDosArquivos = doDisco();
    const r = await executar(m);
    assert.deepEqual(r.removidos.map((x) => [x.tipo, x.hash, x.arquivos.map((f) => f.nome), x.pastaRemovida]), [['TEMPORARIO_RESIDUAL', reg.shaEnvio, [tmp.nome], false]]);
    assert.equal(fs.existsSync(tmp.caminho), false);
    assert.deepEqual(doDisco(), antesDosArquivos, 'o conteúdo dos arquivos da imagem, lido do DISCO, não mudou');
    assert.deepEqual(m.destrutivas().map((c) => [c.metodo, c.rel]), [['unlink', `${reg.pasta}/${tmp.nome}`]], 'uma única operação: o unlink do temporário (sem rmdir)');
  });

  test('REM-05 — pasta SEM registro que só tinha um temporário antigo: sai o temporário e, ficando vazia e sem registro, a própria pasta', async () => {
    const m = mundo();
    const hash = h.hex64('r5-so-temporario');
    const tmp = a.criarTemporario(m.raiz, { hash, nome: 'miniatura.webp', idadeMin: 3 * DIA });
    const r = await executar(m);
    assert.deepEqual(r.removidos.map((x) => [x.tipo, x.arquivos.map((f) => f.nome), x.pastaRemovida]), [['TEMPORARIO_RESIDUAL', [tmp.nome], true]]);
    assert.equal(fs.existsSync(path.join(m.raiz, '7', hash)), false);
    assert.equal(fs.existsSync(path.join(m.raiz, '7')), true, 'a pasta da empresa nunca é removida');
    assert.deepEqual(m.destrutivas().map((c) => [c.metodo, c.rel]), [['unlink', `7/${hash}/${tmp.nome}`], ['rmdir', `7/${hash}`]], 'só o temporário e a pasta da imagem: nunca um rmdir da pasta da empresa');
  });

  test('REM-06 — variante extra numa pasta registrada: sai só a que o REGISTRO não espera, conforme o formato do registro (PNG espera mestre.png; JPEG espera mestre.jpg)', async () => {
    const m = mundo({ registradas: 0 });
    const png = h.criarImagemEmpresa(m.raiz, { id: 1, empresaId: 7, semente: 'r6-png', formato: 'PNG', agora: AGORA });
    const jpeg = h.criarImagemEmpresa(m.raiz, { id: 2, empresaId: 7, semente: 'r6-jpeg', formato: 'JPEG', agora: AGORA });
    m.banco.registro.push(png.linha, jpeg.linha);
    const extraNoPng = path.join(m.raiz, png.pasta, 'mestre.jpg');
    const extraNoJpeg = path.join(m.raiz, jpeg.pasta, 'mestre.png');
    for (const extra of [extraNoPng, extraNoJpeg]) { fs.writeFileSync(extra, 'extra'); a.envelhecer(extra, 3 * DIA); }
    const r = await executar(m);
    assert.deepEqual(r.removidos.map((x) => [x.tipo, x.hash, x.arquivos.map((f) => f.nome), x.pastaRemovida]).sort(),
      [['ORFAO_VARIANTE', png.shaEnvio, ['mestre.jpg'], false], ['ORFAO_VARIANTE', jpeg.shaEnvio, ['mestre.png'], false]].sort());
    assert.equal(fs.existsSync(extraNoPng) || fs.existsSync(extraNoJpeg), false);
    for (const imagem of [png, jpeg]) for (const variante of ['mestre', 'exibicao', 'miniatura']) assert.equal(fs.existsSync(imagem.caminho(variante)), true, `${imagem.pasta} ${variante}`);
  });

  test('REM-07 — a ordem é a do relatório (empresa, hash); em cada conjunto todos os unlink vêm antes do rmdir, e o rmdir é a última operação do conjunto', async () => {
    const m = mundo({ empresas: [7, 8], orfaos: [
      { semente: 'r7-a', empresaId: 8, idadeMin: 3 * DIA }, { semente: 'r7-b', empresaId: 7, idadeMin: 3 * DIA }, { semente: 'r7-c', empresaId: 7, idadeMin: 4 * DIA },
    ] });
    const r = await executar(m);
    assert.equal(r.removidos.length, 3, 'os três conjuntos foram removidos: sem isso a ordem seria afirmada sobre uma lista vazia');
    const planejada = r.removidos.map((x) => `${x.empresaId}/${x.hash}`);
    assert.deepEqual(planejada, [...planejada].sort((x, y) => (Number(x.split('/')[0]) - Number(y.split('/')[0])) || comparar(x, y)));
    const porConjunto = new Map();
    for (const c of m.destrutivas()) {
      const pasta = c.rel.split('/').slice(0, 2).join('/');
      porConjunto.set(pasta, [...(porConjunto.get(pasta) ?? []), c.metodo]);
    }
    assert.deepEqual([...porConjunto.keys()], planejada, 'conjunto por conjunto, na ordem do relatório');
    for (const metodos of porConjunto.values()) assert.deepEqual(metodos, ['unlink', 'unlink', 'unlink', 'rmdir']);
  });

  test('REM-08 — TODA operação destrutiva é de um arquivo ou pasta planejados: unlink só de nome validado dentro de <empresa>/<hash>/, rmdir só da pasta da imagem; nunca a raiz, a pasta da empresa ou "padrao"', async () => {
    const m = mundo({ registradas: 1, orfaos: [{ semente: 'r8-a', idadeMin: 3 * DIA }, { semente: 'r8-vazio', idadeMin: 3 * DIA, variantes: [] }, { semente: 'r8-padrao', escopo: 'PADRAO', idadeMin: 3 * DIA }] });
    a.criarTemporario(m.raiz, { hash: m.registradas[0].shaEnvio, nome: 'exibicao.webp', idadeMin: 3 * DIA });
    const r = await executar(m);
    const planejadosArquivo = new Set(r.candidatos.flatMap((c) => c.arquivos.map((nome) => `${c.empresaId}/${c.hash}/${nome}`)));
    // Só um conjunto órfão (sem registro) pode ter a pasta removida; o temporário desta cena está numa pasta REGISTRADA, que nunca recebe rmdir.
    const planejadosPasta = new Set(r.candidatos.filter((c) => c.tipo === 'ORFAO_CONJUNTO').map((c) => `${c.empresaId}/${c.hash}`));
    const destrutivas = m.destrutivas();
    assert.ok(destrutivas.length > 0);
    for (const c of destrutivas) {
      assert.ok(['unlink', 'rmdir'].includes(c.metodo), c.metodo);
      if (c.metodo === 'unlink') { assert.match(c.rel, ARQUIVO_VALIDADO); assert.ok(planejadosArquivo.has(c.rel), `unlink fora do plano: ${c.rel}`); } else {
        assert.match(c.rel, PASTA_DE_UMA_IMAGEM);
        assert.ok(planejadosPasta.has(c.rel), `rmdir fora do plano: ${c.rel}`);
      }
      assert.equal(c.rel.startsWith('padrao'), false);
    }
    assert.equal(fs.existsSync(path.join(m.raiz, 'padrao', m.orfaos[2].hash)), true, 'o órfão do escopo padrão fica');
  });

  test('REM-09 — `limite` corta a execução nos primeiros N candidatos da ordem do relatório e informa `restantes`; novas execuções terminam o trabalho', async () => {
    const m = mundo({ orfaos: Array.from({ length: 5 }, (_, i) => ({ semente: `r9-${i}`, idadeMin: 3 * DIA })) });
    const ordem = [...m.orfaos].sort(porHash).map((o) => o.hash);
    const r1 = await executar(m, { limite: 2 });
    assert.deepEqual(hashes(r1.removidos), ordem.slice(0, 2));
    assert.deepEqual([r1.restantes, r1.resumo.restantes, r1.limite], [3, 3, 2]);
    assert.equal(m.orfaos.filter((o) => o.existe()).length, 3);
    const r2 = await executar(m, { limite: 2 });
    assert.deepEqual(hashes(r2.removidos), ordem.slice(2, 4));
    assert.equal(r2.restantes, 1);
    const r3 = await executar(m, { limite: 2 });
    assert.deepEqual(hashes(r3.removidos), ordem.slice(4));
    assert.equal(r3.restantes, 0);
    assert.equal(m.orfaos.some((o) => o.existe()), false);
  });

  test('REM-10 — falha ao apagar um arquivo ISOLA o conjunto (falhas, com o código do sistema); os outros são removidos, a execução segue e a trava é solta; a próxima execução completa o conjunto parcial', async () => {
    const m = mundo({ orfaos: [{ semente: 'r10-a', idadeMin: 3 * DIA }, { semente: 'r10-b', idadeMin: 3 * DIA }, { semente: 'r10-c', idadeMin: 3 * DIA }] });
    const ordenados = [...m.orfaos].sort(porHash);
    const doMeio = ordenados[1];
    const quebrado = a.fachadaDeLimpeza(m.raiz, { eventos: m.eventos, falhas: [{ metodo: 'unlink', ondeIgual: `${doMeio.relPasta}/mestre.png`, codigo: 'EACCES' }] });
    const r = await executar(m, { fs: quebrado.fs });
    assert.deepEqual(r.falhas, [{ empresaId: 7, hash: doMeio.hash, tipo: 'ORFAO_CONJUNTO', codigo: 'FALHA_AO_REMOVER', codigoSistema: 'EACCES' }]);
    assert.deepEqual(hashes(r.removidos), [ordenados[0].hash, ordenados[2].hash]);
    assert.deepEqual(doMeio.nomes(), ['mestre.png', 'miniatura.webp'], 'a variante que veio antes do erro já saiu; o resto fica');
    assert.equal(fs.existsSync(m.arquivoDaJanela), false, 'a trava de janela foi solta');
    assert.equal(transacoes(m.eventos).slice(1).every((t) => t.fim >= 0), true, 'nenhuma transação ficou aberta, nem a do conjunto que falhou');
    const segunda = await executar(m);
    assert.deepEqual(hashes(segunda.removidos), [doMeio.hash]);
    assert.equal(doMeio.existe(), false);
    assert.equal(segunda.removidos[0].pastaRemovida, true);
  });

  test('REM-11 — rmdir que acusa pasta NÃO VAZIA (algo apareceu): os arquivos saíram, a pasta fica (pastaRemovida falso) e isso NÃO é falha', async () => {
    const m = mundo({ orfaos: [{ semente: 'r11', idadeMin: 3 * DIA }] });
    const comEnotempty = a.fachadaDeLimpeza(m.raiz, { eventos: m.eventos, falhas: [{ metodo: 'rmdir', ondeContem: m.orfaos[0].hash, codigo: 'ENOTEMPTY' }] });
    const r = await executar(m, { fs: comEnotempty.fs });
    assert.deepEqual(r.falhas, []);
    assert.deepEqual(r.removidos.map((x) => [x.hash, x.pastaRemovida]), [[m.orfaos[0].hash, false]]);
    assert.equal(m.orfaos[0].existe(), true, 'a pasta continua lá');
    assert.deepEqual(m.orfaos[0].nomes(), []);
  });

  test('REM-12 — os ganchos são chamados na ordem: aposPlanejar (uma vez), depois, para cada candidato, aposTravar → antesDeRemover → aposRemover, cada um com { empresaId, hash, tipo }', async () => {
    const m = mundo({ orfaos: [{ semente: 'r12-a', idadeMin: 3 * DIA }, { semente: 'r12-b', idadeMin: 3 * DIA }] });
    const chamados = [];
    const gancho = (nome) => async (c) => { chamados.push([nome, c.candidatos ? c.candidatos.length : [c.empresaId, c.hash, c.tipo]]); };
    const r = await executar(m, { ganchos: { aposPlanejar: gancho('aposPlanejar'), aposTravar: gancho('aposTravar'), antesDeRemover: gancho('antesDeRemover'), aposRemover: gancho('aposRemover') } });
    const [x, y] = hashes(r.removidos);
    const id = (hash) => [7, hash, 'ORFAO_CONJUNTO'];
    assert.deepEqual(chamados, [
      ['aposPlanejar', 2],
      ['aposTravar', id(x)], ['antesDeRemover', id(x)], ['aposRemover', id(x)],
      ['aposTravar', id(y)], ['antesDeRemover', id(y)], ['aposRemover', id(y)],
    ]);
  });
});

describe('[USO] proteção de imagens em uso: o que tem registro nunca é tocado', () => {
  test('USO-01 — imagem registrada ATIVA, INATIVA e vinculada a material, mesmo com 30 dias: só o resíduo de gravação (temporário) de cada pasta sai; nenhum arquivo da imagem nem a pasta recebe operação destrutiva e o conteúdo, lido do disco, não muda', async () => {
    const m = mundo({
      registradas: 3,
      orfaos: [{ semente: 'u1-orfao', idadeMin: 30 * DIA }],
      bancoOpcoes: { usoEmpresa: [{ empresa_id: 7, imagem_id: '3', materiais: 2 }] },
    });
    for (const reg of m.registradas) for (const variante of ['mestre', 'exibicao', 'miniatura']) a.envelhecer(reg.caminho(variante), 30 * DIA);
    m.registradas[1].linha.estado = 'INATIVA';
    const residuos = m.registradas.map((reg) => a.criarTemporario(m.raiz, { hash: reg.shaEnvio, nome: 'mestre.png', idadeMin: 5 * DIA }));
    const doDisco = (reg) => ['mestre', 'exibicao', 'miniatura'].map((variante) => [reg.caminho(variante), h.sha(fs.readFileSync(reg.caminho(variante))), fs.statSync(reg.caminho(variante)).mtimeMs]);
    const antes = m.registradas.map(doDisco);
    const r = await executar(m);
    assert.deepEqual(r.removidos.map((x) => [x.tipo, x.hash]).sort(), [
      ['ORFAO_CONJUNTO', m.orfaos[0].hash], ...m.registradas.map((reg) => ['TEMPORARIO_RESIDUAL', reg.shaEnvio]),
    ].sort());
    assert.deepEqual(m.destrutivas().filter((c) => c.metodo === 'unlink' && c.rel.startsWith(m.orfaos[0].relPasta) === false).map((c) => c.rel).sort(),
      residuos.map((tmp, i) => `${m.registradas[i].pasta}/${tmp.nome}`).sort(), 'fora do órfão, os únicos unlink são os dos temporários');
    assert.equal(m.destrutivas().some((c) => c.metodo === 'rmdir' && m.registradas.some((reg) => c.rel === reg.pasta)), false, 'a pasta de imagem registrada nunca recebe rmdir');
    assert.deepEqual(m.registradas.map(doDisco), antes);
  });

  test('USO-02 — o registro APARECE depois do plano (um envio adotou o conjunto): sob a trava a limpeza relê, vê o registro e IGNORA com REGISTRO_APARECEU; os arquivos ficam e os outros conjuntos seguem', async () => {
    const m = mundo({ orfaos: [{ semente: 'u2-a', idadeMin: 3 * DIA }, { semente: 'u2-b', idadeMin: 3 * DIA }] });
    const [adotado, outro] = m.orfaos;
    const r = await executar(m, { ganchos: { aposPlanejar: async () => { m.banco.registro.push(a.linhaQueCobre(adotado, { id: 50 })); } } });
    assert.deepEqual(r.ignorados, [{ empresaId: 7, hash: adotado.hash, tipo: 'ORFAO_CONJUNTO', motivo: 'REGISTRO_APARECEU' }]);
    assert.deepEqual(hashes(r.removidos), [outro.hash]);
    assert.deepEqual(adotado.nomes(), NOMES_DO_CONJUNTO, 'o conjunto adotado fica inteiro');
    assert.equal(m.destrutivas().some((c) => c.rel.startsWith(adotado.relPasta)), false);
  });

  test('USO-03 — um arquivo do conjunto fica MAIS NOVO depois do plano (regravado): MAIS_NOVO_QUE_A_RETENCAO, nada do conjunto é removido', async () => {
    const m = mundo({ orfaos: [{ semente: 'u3', idadeMin: 3 * DIA }] });
    const r = await executar(m, { ganchos: { aposPlanejar: async () => { a.envelhecer(m.orfaos[0].caminhos['mestre.png'], 5); } } });
    assert.deepEqual(r.ignorados.map((x) => [x.hash, x.motivo]), [[m.orfaos[0].hash, 'MAIS_NOVO_QUE_A_RETENCAO']]);
    assert.deepEqual(r.removidos, []);
    assert.deepEqual(m.orfaos[0].nomes(), NOMES_DO_CONJUNTO);
    assert.deepEqual(m.destrutivas(), []);
  });

  test('USO-04 — uma entrada ESTRANHA aparece na pasta depois do plano: ENTRADA_ESTRANHA, e NADA do conjunto é removido (nem os arquivos legítimos)', async () => {
    const m = mundo({ orfaos: [{ semente: 'u4', idadeMin: 3 * DIA }] });
    const r = await executar(m, { ganchos: { aposPlanejar: async () => { fs.writeFileSync(path.join(m.orfaos[0].pasta, 'intruso.txt'), 'x'); } } });
    assert.deepEqual(r.ignorados.map((x) => [x.hash, x.motivo]), [[m.orfaos[0].hash, 'ENTRADA_ESTRANHA']]);
    assert.deepEqual(m.orfaos[0].nomes(), [...NOMES_DO_CONJUNTO, 'intruso.txt'].sort());
    assert.deepEqual(m.destrutivas(), []);
  });

  test('USO-05 — o conjunto SUMIU depois do plano (outra limpeza ou uma pessoa): JA_REMOVIDO, sem erro e sem falha', async () => {
    const m = mundo({ orfaos: [{ semente: 'u5-a', idadeMin: 3 * DIA }, { semente: 'u5-b', idadeMin: 3 * DIA }] });
    const [primeiro] = [...m.orfaos].sort(porHash);
    const r = await executar(m, { ganchos: { aposPlanejar: async () => { fs.rmSync(primeiro.pasta, { recursive: true }); } } });
    assert.deepEqual(r.ignorados.map((x) => [x.hash, x.motivo]), [[primeiro.hash, 'JA_REMOVIDO']]);
    assert.deepEqual(r.falhas, []);
    assert.equal(r.removidos.length, 1);
  });

  test('USO-06 — a conferência do registro é feita SOB A TRAVA da biblioteca da MESMA empresa, antes de qualquer remoção, e a transação só termina depois dela (ordem: BEGIN, TRAVA, REGISTRO, remoções, COMMIT)', async () => {
    const m = mundo({ empresas: [7, 8], orfaos: [{ semente: 'u6-a', empresaId: 7, idadeMin: 3 * DIA }, { semente: 'u6-b', empresaId: 8, idadeMin: 3 * DIA }] });
    const r = await executar(m);
    assert.equal(r.removidos.length, 2);
    const [, ...porConjunto] = transacoes(m.eventos);
    assert.equal(porConjunto.length, 2, 'uma transação por conjunto');
    for (const [i, segmento] of porConjunto.entries()) {
      const removido = r.removidos[i];
      const { tipos } = segmento;
      const iTrava = tipos.indexOf('TRAVA');
      const iRegistro = tipos.indexOf('REGISTRO');
      const primeiraRemocao = tipos.indexOf('FS');
      const ultimaRemocao = tipos.lastIndexOf('FS');
      assert.ok(iTrava > 0 && iRegistro > iTrava && primeiraRemocao > iRegistro, `ordem no conjunto ${i}: ${tipos.join(' > ')}`);
      assert.ok(segmento.fim > ultimaRemocao, `a transação só termina DEPOIS da última remoção (confirmada ou desfeita: ela só lê): ${tipos.join(' > ')}`);
      assert.equal(tipos.slice(segmento.fim + 1).includes('FS'), false, 'nada é removido depois que a transação terminou');
      assert.deepEqual(segmento.eventos[iTrava].params, [lockDaBiblioteca(removido.empresaId)], 'a trava é a da biblioteca DESTA empresa (a mesma do envio)');
      assert.deepEqual([segmento.eventos[iRegistro].empresaId, segmento.eventos[iRegistro].sha], [removido.empresaId, removido.hash]);
    }
  });

  test('USO-07 — as transações da execução são todas READ ONLY (uma por candidato, além do instantâneo do verificador), todas terminadas, e a limpeza nunca escreve no banco', async () => {
    const m = mundo({ orfaos: [{ semente: 'u7-a', idadeMin: 3 * DIA }, { semente: 'u7-b', idadeMin: 3 * DIA }] });
    await executar(m);
    const transacoesDaExecucao = transacoes(m.eventos);
    assert.equal(transacoesDaExecucao.length, 3, 'o instantâneo do verificador e uma transação por conjunto');
    assert.equal(transacoesDaExecucao.every((t) => t.somenteLeitura), true, 'READ ONLY declarado no BEGIN ou logo em seguida (SET TRANSACTION)');
    assert.equal(transacoesDaExecucao.every((t) => t.fim >= 0), true, 'nenhuma transação ficou aberta (um ROLLBACK defensivo a mais depois do COMMIT é tolerado)');
    assert.ok(m.banco.contadores.conexoes >= 2, 'o instantâneo do verificador e ao menos uma conexão para as transações por conjunto');
    assert.equal(m.banco.contadores.conexoes, m.banco.contadores.liberacoes, 'toda conexão foi devolvida');
    for (const sql of m.banco.sql) assert.doesNotMatch(sql, /\b(INSERT|UPDATE|DELETE|TRUNCATE|CREATE|ALTER|DROP)\b/i);
  });

  test('USO-08 — a biblioteca PADRÃO nunca é removida, nem com tudo liberado: fica em foraDoEscopo, nenhuma trava é tomada para ela e nenhum unlink toca "padrao/"', async () => {
    const m = mundo({ orfaos: [{ semente: 'u8-padrao', escopo: 'PADRAO', idadeMin: 40 * DIA }] });
    const antes = h.retratoDaArvore(path.join(m.raiz, 'padrao'));
    const r = await executar(m);
    assert.deepEqual(r.removidos, []);
    assert.equal(r.foraDoEscopo.length, 1);
    assert.deepEqual(h.retratoDaArvore(path.join(m.raiz, 'padrao')), antes);
    assert.equal(m.eventos.some((e) => e.tipo === 'TRAVA'), false);
    assert.deepEqual(m.destrutivas(), []);
  });

  test('USO-09 — isolamento por empresa na execução: o MESMO hash registrado na empresa 7 e solto na 8 — só a pasta da 8 sai; a conferência do registro é feita com a empresa do CANDIDATO (8)', async () => {
    const m = mundo({ empresas: [7, 8] });
    const doOutro = a.criarOrfao(m.raiz, { empresaId: 8, semente: 'u9', hash: m.registradas[0].shaEnvio, idadeMin: 3 * DIA });
    const r = await executar(m);
    assert.deepEqual(r.removidos.map((x) => [x.empresaId, x.hash]), [[8, m.registradas[0].shaEnvio]]);
    assert.equal(doOutro.existe(), false);
    assert.equal(fs.existsSync(path.join(m.raiz, m.registradas[0].pasta)), true, 'a pasta registrada da empresa 7 fica');
    const consulta = m.eventos.find((e) => e.tipo === 'REGISTRO');
    assert.deepEqual([consulta.empresaId, consulta.sha], [8, m.registradas[0].shaEnvio]);
  });

  test('USO-10 — armazenamento NÃO confiável (entrada estranha, link, empresa inexistente, registro com arquivo ausente, banco errado, raiz ausente): a execução é RECUSADA, nenhum órfão é removido e a trava é solta', async () => {
    const casos = {
      'entrada estranha': (m) => fs.writeFileSync(path.join(m.raiz, 'LEIAME.txt'), 'x'),
      'link simbólico': (m) => fs.symlinkSync(novaRaiz(), path.join(m.raiz, '7', h.hex64('u10-link'))),
      'empresa inexistente': (m) => a.criarOrfao(m.raiz, { empresaId: 99, semente: 'u10-fantasma', idadeMin: 30 * DIA }),
      'registro com arquivo ausente': (m) => {
        const incompleta = h.criarImagemEmpresa(m.raiz, { id: 40, empresaId: 7, semente: 'u10-incompleta', agora: AGORA, ausentes: ['miniatura'] });
        m.banco.registro.push(incompleta.linha);
      },
    };
    for (const [rotulo, montar] of Object.entries(casos)) {
      const m = mundo({ orfaos: [{ semente: `u10-${rotulo.length}`, idadeMin: 3 * DIA }] });
      montar(m);
      const antes = m.retrato();
      const r = await executar(m);
      assert.equal(r.recusa?.codigo, 'ARMAZENAMENTO_NAO_CONFIAVEL', rotulo);
      assert.deepEqual([r.removidos, r.ignorados, r.falhas], [[], [], []], rotulo);
      assert.deepEqual(m.destrutivas(), [], rotulo);
      assert.deepEqual(m.retrato(), antes, rotulo);
      assert.equal(m.eventos.some((e) => e.tipo === 'TRAVA'), false, 'nenhuma trava de biblioteca foi tomada');
      assert.equal(fs.existsSync(m.arquivoDaJanela), false, `${rotulo}: a trava de janela foi solta`);
    }
    const bancoErrado = mundo({ registradas: 0, orfaos: [{ semente: 'u10-banco-errado', idadeMin: 30 * DIA }] });
    const rBanco = await executar(bancoErrado);
    assert.equal(rBanco.recusa?.codigo, 'ARMAZENAMENTO_NAO_CONFIAVEL');
    assert.equal(bancoErrado.orfaos[0].existe(), true, 'banco que não parece o certo: nada é apagado');
    const semRaiz = mundo();
    const pai = novaRaiz();
    const ausente = path.join(pai, 'nao-existe');
    const rSemRaiz = await executar(semRaiz, { diretorio: ausente });
    assert.equal(rSemRaiz.recusa?.codigo, 'ARMAZENAMENTO_NAO_CONFIAVEL');
    assert.equal(fs.existsSync(ausente), false, 'a raiz não é criada');
    assert.deepEqual(fs.readdirSync(pai), []);
    assert.equal(fs.existsSync(semRaiz.arquivoDaJanela), false, 'a trava de janela foi solta');
  });

  test('USO-11 — a trava da biblioteca estoura o tempo máximo (SQLSTATE 55P03): o conjunto é IGNORADO com TRAVA_OCUPADA, nada é removido dele, a transação termina e os outros conjuntos seguem', async () => {
    const m = mundo({ empresas: [7, 8], orfaos: [{ semente: 'u11-a', empresaId: 7, idadeMin: 3 * DIA }, { semente: 'u11-b', empresaId: 8, idadeMin: 3 * DIA }] });
    const trava7 = lockDaBiblioteca(7);
    const banco = a.criarBancoDeLimpeza({
      empresas: [7, 8],
      empresa: m.registradas.map((imagem) => imagem.linha),
      eventos: m.eventos,
      aoConsultar: (sql, params) => {
        if (/advisory/i.test(sql) && params?.[0] === trava7) throw Object.assign(new Error('canceling statement due to lock timeout'), { code: '55P03' });
      },
    });
    const r = await S().limparOrfaos(banco, {
      diretorio: m.raiz, fs: m.fs, agora: () => AGORA, executar: true, intervaloBackupMinutos: 60, ...comJanela(m), tempoMaximoDaTravaMs: 100,
    });
    const [daEmpresa7, daEmpresa8] = m.orfaos;
    assert.deepEqual(r.ignorados, [{ empresaId: 7, hash: daEmpresa7.hash, tipo: 'ORFAO_CONJUNTO', motivo: 'TRAVA_OCUPADA' }]);
    assert.deepEqual(hashes(r.removidos), [daEmpresa8.hash]);
    assert.deepEqual(r.falhas, []);
    assert.deepEqual(daEmpresa7.nomes(), NOMES_DO_CONJUNTO);
    assert.equal(transacoes(m.eventos).slice(1).every((t) => t.fim >= 0), true, 'a transação do conjunto ignorado também terminou');
    assert.equal(banco.contadores.conexoes, banco.contadores.liberacoes, 'toda conexão foi devolvida');
  });

  test('USO-12 — uma variante é TROCADA por um link simbólico depois do plano: ENTRADA_ESTRANHA, nada do conjunto é removido e o alvo do link nunca é tocado', async () => {
    const alheia = novaRaiz();
    const alvo = path.join(alheia, 'segredo.txt');
    fs.writeFileSync(alvo, 'conteudo-que-nao-pode-ser-tocado');
    const m = mundo({ orfaos: [{ semente: 'u12', idadeMin: 3 * DIA }] });
    const r = await executar(m, { ganchos: { aposPlanejar: async () => {
      fs.rmSync(m.orfaos[0].caminhos['mestre.png']);
      fs.symlinkSync(alvo, m.orfaos[0].caminhos['mestre.png']);
    } } });
    assert.deepEqual(r.ignorados.map((x) => [x.hash, x.motivo]), [[m.orfaos[0].hash, 'ENTRADA_ESTRANHA']]);
    assert.deepEqual(m.destrutivas(), []);
    assert.equal(fs.readFileSync(alvo, 'utf8'), 'conteudo-que-nao-pode-ser-tocado');
    assert.equal(fs.lstatSync(m.orfaos[0].caminhos['mestre.png']).isSymbolicLink(), true);
    assert.deepEqual(m.orfaos[0].nomes(), NOMES_DO_CONJUNTO);
  });
});

describe('[MUT] exclusão mútua com o backup (trava de janela de escrita)', () => {
  test('MUT-01 — EXECUTAR sem a janela configurada é recusado (JANELA_NAO_CONFIGURADA): falha fechada, nada lido, nada removido', async () => {
    const m = mundo({ orfaos: [{ semente: 'mu1', idadeMin: 30 * DIA }] });
    const r = await rodar(m, { executar: true, intervaloBackupMinutos: 60 });
    assert.equal(r.recusa?.codigo, 'JANELA_NAO_CONFIGURADA');
    assert.equal(m.banco.contadores.conexoes, 0);
    assert.deepEqual(m.chamadas, []);
    assert.equal(m.orfaos[0].existe(), true);
  });

  test('MUT-02 — com um BACKUP em andamento (ou outra limpeza) a execução é recusada: JANELA_OCUPADA com o dono, nada lido do banco nem do disco, órfão intacto e a trava alheia byte a byte igual', async () => {
    for (const tipo of ['BACKUP', 'LIMPEZA']) {
      const m = mundo({ orfaos: [{ semente: `mu2-${tipo}`, idadeMin: 30 * DIA }] });
      const doc = a.escreverTravaAlheia(m.arquivoDaJanela, { tipo, pid: 4242 });
      const antes = fs.readFileSync(m.arquivoDaJanela);
      const r = await executar(m);
      assert.deepEqual(r.recusa, { codigo: 'JANELA_OCUPADA', dono: { tipo, pid: 4242, iniciadoEm: doc.iniciadoEm } }, tipo);
      assert.deepEqual(r.impedimentos, ['JANELA_OCUPADA']);
      assert.equal(r.executavel, false);
      assert.equal(m.banco.contadores.conexoes, 0, 'nenhuma conexão');
      assert.deepEqual(m.chamadas, [], 'nenhuma leitura do disco');
      assert.equal(m.orfaos[0].existe(), true);
      assert.deepEqual(fs.readFileSync(m.arquivoDaJanela), antes);
    }
  });

  test('MUT-03 — enquanto a limpeza trabalha a trava EXISTE (tipo LIMPEZA, pid do processo, instante do relógio injetado) e um BACKUP não consegue assumir a janela; ao terminar a trava some', async () => {
    const m = mundo({ orfaos: [{ semente: 'mu3', idadeMin: 3 * DIA }] });
    const observado = {};
    const r = await executar(m, { ganchos: { antesDeRemover: async () => {
      observado.documento = JSON.parse(fs.readFileSync(m.arquivoDaJanela, 'utf8'));
      const janela = exigirModulo('src/utils/janela-escrita-imagens');
      observado.erro = await janela.adquirirJanela({ arquivo: m.arquivoDaJanela, tipo: 'BACKUP', raizArmazenamento: m.raiz }).then(() => null, (e) => e);
    } } });
    assert.equal(observado.documento.tipo, 'LIMPEZA');
    assert.equal(observado.documento.pid, process.pid);
    assert.equal(observado.documento.iniciadoEm, new Date(AGORA).toISOString());
    assert.equal(observado.erro?.codigo, 'JANELA_OCUPADA');
    assert.equal(observado.erro.dono.tipo, 'LIMPEZA');
    assert.equal(fs.existsSync(m.arquivoDaJanela), false);
    assert.deepEqual(r.janela, { configurada: true, estado: 'LIBERADA', dono: null });
    assert.equal(r.removidos.length, 1);
  });

  test('MUT-04 — a trava é tomada ANTES de qualquer leitura (disco ou banco) e solta só DEPOIS do último commit', async () => {
    const m = mundo({ orfaos: [{ semente: 'mu4', idadeMin: 3 * DIA }] });
    const existia = [];
    const marcar = (origem) => { existia.push([origem, fs.existsSync(m.arquivoDaJanela)]); };
    const fsObservado = { ...m.fs, lstat: async (...args) => { marcar('lstat'); return m.fs.lstat(...args); }, realpath: async (...args) => { marcar('realpath'); return m.fs.realpath(...args); } };
    const banco = a.criarBancoDeLimpeza({ empresas: [7], empresa: m.registradas.map((i) => i.linha), eventos: m.eventos, aoConsultar: (sql) => { marcar(sql.split(' ')[0]); } });
    await S().limparOrfaos(banco, {
      diretorio: m.raiz, fs: Object.freeze(fsObservado), agora: () => AGORA, executar: true, intervaloBackupMinutos: 60, ...comJanela(m),
    });
    assert.equal(existia.length > 4, true);
    assert.deepEqual(existia.filter(([, existe]) => !existe), [], 'em toda leitura e comando a trava já existia');
    assert.ok(['COMMIT', 'ROLLBACK'].includes(existia.at(-1)[0]), 'o último comando encerra a transação do último conjunto, com a trava ainda de pé');
    assert.equal(fs.existsSync(m.arquivoDaJanela), false, 'e só depois dele a trava é solta');
  });

  test('MUT-05 — erro no meio da execução (banco cai, gancho falha) é propagado, mas a trava de janela é SEMPRE solta e nenhum conjunto seguinte é tocado', async () => {
    for (const falha of ['banco', 'gancho']) {
      const m = mundo({ orfaos: [{ semente: `mu5-${falha}-a`, idadeMin: 3 * DIA }, { semente: `mu5-${falha}-b`, idadeMin: 3 * DIA }] });
      const opcoes = falha === 'banco'
        ? { aoConsultar: (sql) => { if (/advisory/i.test(sql)) throw Object.assign(new Error('banco indisponível'), { code: '57P01' }); } }
        : {};
      const banco = falha === 'banco' ? a.criarBancoDeLimpeza({ empresas: [7], empresa: m.registradas.map((i) => i.linha), eventos: m.eventos, ...opcoes }) : m.banco;
      await assert.rejects(S().limparOrfaos(banco, {
        diretorio: m.raiz,
        fs: m.fs,
        agora: () => AGORA,
        executar: true,
        intervaloBackupMinutos: 60,
        ...comJanela(m),
        ganchos: falha === 'gancho' ? { antesDeRemover: async () => { throw new Error('falha injetada'); } } : {},
      }), (erro) => erro.message === (falha === 'gancho' ? 'falha injetada' : 'banco indisponível'), `${falha}: o erro propagado é o injetado, não outro qualquer`);
      assert.equal(fs.existsSync(m.arquivoDaJanela), false, `${falha}: a trava foi solta`);
      assert.equal(m.orfaos.filter((o) => o.existe()).length, 2, `${falha}: nada foi removido`);
      assert.equal(banco.contadores.conexoes, banco.contadores.liberacoes, `${falha}: toda conexão foi devolvida ao pool`);
      if (falha === 'banco') assert.ok(banco.contadores.conexoes >= 2, 'o erro veio da trava do conjunto: o plano e a transação do conjunto abriram conexão');
    }
  });

  test('MUT-06 — duas execuções ao mesmo tempo no mesmo armazenamento: enquanto a primeira trabalha, a segunda é recusada (JANELA_OCUPADA, dono LIMPEZA) e não remove nem lê nada; a primeira conclui', async () => {
    const m = mundo({ orfaos: [{ semente: 'mu6', idadeMin: 3 * DIA }] });
    const segundo = a.criarBancoDeLimpeza({ empresas: [7], empresa: m.registradas.map((i) => i.linha) });
    const fachada2 = a.fachadaDeLimpeza(m.raiz);
    let r2 = null;
    const r1 = await executar(m, { ganchos: { antesDeRemover: async () => {
      r2 = await S().limparOrfaos(segundo, { diretorio: m.raiz, fs: fachada2.fs, agora: () => AGORA, executar: true, intervaloBackupMinutos: 60, ...comJanela(m) });
    } } });
    assert.equal(r2.recusa?.codigo, 'JANELA_OCUPADA');
    assert.equal(r2.recusa.dono.tipo, 'LIMPEZA');
    assert.equal(segundo.contadores.conexoes, 0);
    assert.deepEqual(fachada2.chamadas, []);
    assert.equal(r1.removidos.length, 1);
    assert.equal(m.orfaos[0].existe(), false);
  }, { timeout: 60000 });

  test('MUT-07 — janela com caminho inválido ou DENTRO do armazenamento é recusada na execução (JANELA_INVALIDA, com o motivo) antes de ler qualquer coisa, sem criar arquivo na árvore de imagens', async () => {
    const m = mundo({ orfaos: [{ semente: 'mu7', idadeMin: 3 * DIA }] });
    const antes = m.retrato();
    const casos = [[path.join(m.raiz, 'janela.lock'), 'JANELA_DENTRO_DO_ARMAZENAMENTO'], ['janela-relativa.lock', 'JANELA_ARQUIVO_INVALIDO']];
    for (const [arquivo, motivo] of casos) {
      const r = await rodar(m, { executar: true, intervaloBackupMinutos: 60, janela: { arquivo } });
      assert.deepEqual(r.recusa, { codigo: 'JANELA_INVALIDA', motivo }, arquivo);
    }
    assert.equal(m.banco.contadores.conexoes, 0);
    assert.deepEqual(m.chamadas, []);
    assert.deepEqual(m.retrato(), antes);
  });

  test('MUT-08 — uma janela que ficou de um processo morto NÃO é quebrada pela limpeza: a execução é recusada e a trava continua lá para uma pessoa decidir', async () => {
    const m = mundo({ orfaos: [{ semente: 'mu8', idadeMin: 3 * DIA }] });
    a.escreverTravaAlheia(m.arquivoDaJanela, { tipo: 'LIMPEZA', pid: a.pidMorto() });
    const r = await executar(m);
    assert.equal(r.recusa?.codigo, 'JANELA_OCUPADA');
    assert.equal(fs.existsSync(m.arquivoDaJanela), true);
    assert.equal(m.orfaos[0].existe(), true);
  });
});
