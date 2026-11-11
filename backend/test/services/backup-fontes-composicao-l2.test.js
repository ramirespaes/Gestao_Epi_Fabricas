'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const CP = require('../../src/services/backup-fontes-composicao-l2.service');
const A = require('../../src/services/backup-fontes-adaptadores.service');
const C = require('../../src/services/backup-fontes-postgres-cobertura.service');
const H = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { obterCatalogo } = require('../../src/services/backup-fontes-catalogo.service');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { criarArmazenamentoLocal } = require('../../src/storage/armazenamento-local');
const S = require('../../src/services/backup-fontes-postgres-sumario.service');

/**
 * D-ORF-6, P6 — composição por fonte do pacote layout 2 e restauração por fonte, com executor SIMULADO (nenhum PostgreSQL) e diretórios temporários
 * próprios (origens sintéticas, preparação, destino). Dados 100% fictícios.
 */

const raizes = [];
after(() => { for (const r of raizes) fs.rmSync(r, { recursive: true, force: true }); });
const novaRaiz = () => { const r = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'gepi-p6-')); fs.chmodSync(r, 0o700); raizes.push(r); return r; };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const SEG = crypto.randomBytes(32);
const fonte = () => H.criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'chave-teste-1', segredo: SEG }] });

/** Origem sintética das imagens: 1 padrão (mestre+miniatura) + 1 da empresa 7 (3 variantes); conteúdo = hash declarado. */
async function montarImagens(raiz) {
  const dir = path.join(raiz, 'imagens');
  fs.mkdirSync(dir, { mode: 0o700 });
  const arm = criarArmazenamentoImagens({ diretorio: dir });
  const mestreP = Buffer.from('padrao-mestre-png'); const miniP = Buffer.from('padrao-mini');
  const mestreE = Buffer.from('empresa-mestre'); const exibE = Buffer.from('empresa-exib'); const miniE = Buffer.from('empresa-mini');
  const hP = sha(mestreP);
  const hE = sha(mestreE);
  const chaves = {
    pm: `padrao/${hP}/mestre.png`, pmi: `padrao/${hP}/miniatura.webp`, em: `7/${hE}/mestre.png`, ee: `7/${hE}/exibicao.webp`, emi: `7/${hE}/miniatura.webp`,
  };
  for (const [chave, b] of [[chaves.pm, mestreP], [chaves.pmi, miniP], [chaves.em, mestreE], [chaves.ee, exibE], [chaves.emi, miniE]]) await arm.gravar(chave, b, { maxBytes: 1024 });
  const padrao = [{ id: '1', sha256: hP, sha256Miniatura: sha(miniP), sha256Exibicao: null, formato: 'PNG', bytesMestre: mestreP.length, bytesMiniatura: miniP.length, bytesExibicao: null }];
  const empresa = [{ id: '1', empresaId: 7, sha256: hE, sha256Mestre: hE, sha256Exibicao: sha(exibE), sha256Miniatura: sha(miniE), formato: 'PNG', bytesMestre: mestreE.length, bytesExibicao: exibE.length, bytesMiniatura: miniE.length }];
  return { dir, arm, padrao, empresa, chaves };
}
async function montarFiscalizacao(raiz) {
  const dir = path.join(raiz, 'fiscalizacao');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(path.join(dir, '7'), { mode: 0o700 });
  const zip = Buffer.from('PK-ficticio-7-3');
  fs.writeFileSync(path.join(dir, '7', 'pacote-3.zip'), zip, { mode: 0o600 });
  const linhas = [{ id: '3', empresaId: '7', status: 'CONCLUIDO', tamanhoBytes: zip.length, sha256: sha(zip), chaveArmazenamento: '7/pacote-3.zip' }];
  return { dir, arm: criarArmazenamentoLocal({ diretorio: dir }), linhas, zip };
}
/** Executor simulado que responde às consultas dos planejadores e do inventário pelo texto do SQL. */
function executorFalso({ padrao, empresa, pacotes }) {
  const consultas = [];
  const inv = require('../../src/repositories/backup-fontes-postgres-inventario.repository');
  return {
    consultas,
    async query(sql, params) {
      consultas.push(sql);
      if (sql === inv.SQL.RELACOES) return { rows: [{ esquema: 'public', nome: 'empresas', relkind: 'r', sustenta_restricao: false, sequencia_implicita: false }] };
      if (sql === inv.SQL.OUTROS) return { rows: inv.CATEGORIAS_DE_OUTROS.map((c) => ({ categoria: c, quantidade: '0' })) };
      if (sql === inv.SQL.EXTENSOES) return { rows: [] };
      if (sql === inv.SQL.SERVIDOR) return { rows: [{ versao: '16.4', encoding: 'UTF8', collate: 'C', ctype: 'C' }] };
      if (sql === inv.SQL.migrations('public')) return { rows: [{ name: '000_a' }] };
      if (/FROM imagens_padrao/.test(sql)) return { rows: params[0] === '0' ? padrao.map((l) => ({ id: l.id, sha256: l.sha256, sha256_miniatura: l.sha256Miniatura, sha256_exibicao: l.sha256Exibicao, formato: l.formato, bytes_mestre: l.bytesMestre, bytes_miniatura: l.bytesMiniatura, bytes_exibicao: l.bytesExibicao })) : [] };
      if (/FROM imagens_empresa/.test(sql)) return { rows: params[0] === '0' ? empresa.map((l) => ({ id: l.id, empresa_id: l.empresaId, sha256: l.sha256, sha256_mestre: l.sha256Mestre, sha256_exibicao: l.sha256Exibicao, sha256_miniatura: l.sha256Miniatura, formato: l.formato, bytes_mestre: l.bytesMestre, bytes_exibicao: l.bytesExibicao, bytes_miniatura: l.bytesMiniatura })) : [] };
      if (/fiscalizacao_pacotes/.test(sql)) return { rows: params[0] === '0' ? pacotes.map((p) => ({ id: p.id, empresa_id: p.empresaId, status: p.status, tamanho_bytes: p.tamanhoBytes, sha256: p.sha256, chave_armazenamento: p.chaveArmazenamento })) : [] };
      throw new Error('SQL inesperado');
    },
  };
}
const sumarioN1 = () => S.lerSumario(';     TOC Entries: 2\n;     Format: CUSTOM\n1; 1259 1 TABLE public empresas d\n2; 0 1 TABLE DATA public empresas d\n');

describe('[P6] composição por fonte do layout 2', () => {
  test('P6-01 — planejarNoSnapshot lê planos (imagens, fiscalização) e inventário no MESMO executor; referências normalizadas com bytes e empresa', async () => {
    const raiz = novaRaiz();
    const img = await montarImagens(raiz);
    const fis = await montarFiscalizacao(raiz);
    const executor = executorFalso({ padrao: img.padrao, empresa: img.empresa, pacotes: fis.linhas });
    const lido = await CP.planejarNoSnapshot({ executor, catalogo: obterCatalogo(), fontes: ['imagens', 'fiscalizacao-pacotes'] });
    assert.deepEqual(Object.keys(lido.planos), ['fiscalizacao-pacotes', 'imagens']);
    assert.equal(lido.planos.imagens.plano.length, 5);
    assert.deepEqual(lido.planos.imagens.plano.map((p) => Object.keys(p)), Array(5).fill(['chave', 'sha256']), 'plano das imagens no formato exato do copiador');
    assert.deepEqual(lido.planos.imagens.referencias.find((r) => r.chave === img.chaves.em), { chave: img.chaves.em, sha256: img.empresa[0].sha256Mestre, bytes: 14, empresaId: '7' });
    assert.deepEqual(lido.planos['fiscalizacao-pacotes'].referencias, [{ chave: '7/pacote-3.zip', sha256: sha(fis.zip), bytes: fis.zip.length, empresaId: '7' }]);
    assert.equal(lido.inventario.relacoes.length, 1);
    assert.ok(executor.consultas.length >= 7, 'tudo no mesmo executor');
    await assert.rejects(CP.planejarNoSnapshot({ executor, catalogo: obterCatalogo(), fontes: ['postgres-aplicacao'] }), (e) => e.code === 'ADAPTADOR_INDISPONIVEL');
    assert.throws(() => A.obterAdaptador('imagens', { ...obterCatalogo(), fontes: obterCatalogo().fontes.map((f) => (f.id === 'imagens' ? { ...f, chave: { formatoChaveId: 'fiscalizacao-v1' } } : f)) }), (e) => e.code === 'ADAPTADOR_INDISPONIVEL');
  });

  test('P6-02 — compor: arquivos/<fonte>/<chave>, manifesto L2 selado e relido, conjunto exato verificado; depois restaurarL2 por fonte com conciliação INTEGRO', async () => {
    const raiz = novaRaiz();
    const img = await montarImagens(raiz);
    const fis = await montarFiscalizacao(raiz);
    const executor = executorFalso({ padrao: img.padrao, empresa: img.empresa, pacotes: fis.linhas });
    const catalogo = obterCatalogo();
    const planejado = await CP.planejarNoSnapshot({ executor, catalogo, fontes: ['imagens', 'fiscalizacao-pacotes'] });
    const preparacao = path.join(raiz, 'prep'); fs.mkdirSync(preparacao, { mode: 0o700 });
    fs.mkdirSync(path.join(preparacao, 'dump'), { mode: 0o700 });
    const dumpBytes = Buffer.from('PGDMP-ficticio');
    fs.writeFileSync(path.join(preparacao, 'dump', 'postgres.dump'), dumpBytes, { mode: 0o600 });
    const postgres = C.avaliarCoberturaPostgres({ inventario: planejado.inventario, sumario: sumarioN1(), migrationsDoCodigo: ['000_a'] });
    assert.equal(postgres.nivelAtingido, 'N1');
    const composicao = CP.criarComposicaoL2({ catalogo, fonteDeChaves: fonte(), chaveId: 'chave-teste-1', maxBytesPorArquivo: 1024 * 1024 });
    const r = await composicao.compor({
      preparacao, planos: planejado.planos, origens: { imagens: img.arm, 'fiscalizacao-pacotes': fis.arm }, banco: { nome: 'gepi_sint', oid: '16384' }, conjuntoId: 'conjunto-p6',
      dump: { bytes: dumpBytes.length, sha256: sha(dumpBytes) }, contexto: { raizesConfiguradas: ['FISCALIZACAO_ARMAZENAMENTO_DIRETORIO', 'IMAGENS_DIRETORIO'], resultadosDinamicos: {} }, postgres,
    });
    assert.equal(r.ok, true, JSON.stringify(r.falha));
    assert.deepEqual(r.fontes, { 'fiscalizacao-pacotes': { planejados: 1, copiados: 1 }, imagens: { planejados: 5, copiados: 5 } });
    assert.ok(fs.existsSync(path.join(preparacao, 'arquivos', 'imagens', ...img.chaves.em.split('/'))));
    assert.ok(fs.existsSync(path.join(preparacao, 'arquivos', 'fiscalizacao-pacotes', '7', 'pacote-3.zip')));
    assert.ok(fs.existsSync(path.join(preparacao, 'manifesto.json')) && fs.existsSync(path.join(preparacao, 'manifesto.sha256')));
    assert.equal(r.manifesto.layout, 2);
    assert.equal(r.manifesto.cobertura.postgres.nivelAtingido, 'N1');
    assert.equal(r.manifesto.cobertura.declaracao, 'NAO_COMPROVADA');
    const pacote = await CP.verificarPacoteL2({ pacote: preparacao, lido: r.escrito });
    assert.deepEqual(pacote, { ok: true, arquivos: 9, sha256Manifesto: r.identidade.sha256Manifesto, layout: 2 });
    // extra no pacote => recusa; o verificador nunca apaga nada
    fs.writeFileSync(path.join(preparacao, 'arquivos', 'extra.bin'), 'x');
    assert.equal((await CP.verificarPacoteL2({ pacote: preparacao, lido: r.escrito })).motivo, 'ARQUIVO_EXTRA');
    fs.rmSync(path.join(preparacao, 'arquivos', 'extra.bin'));
    // compor de novo na mesma preparação: destino existente, nada sobrescrito
    const repetida = await composicao.compor({ preparacao, planos: planejado.planos, origens: { imagens: img.arm, 'fiscalizacao-pacotes': fis.arm }, banco: { nome: 'gepi_sint', oid: '16384' }, conjuntoId: 'conjunto-p6', dump: { bytes: dumpBytes.length, sha256: sha(dumpBytes) }, contexto: {}, postgres });
    assert.deepEqual(repetida.falha, { estagio: 'AREA', codigo: 'DESTINO_EXISTENTE' });

    // RESTAURAÇÃO (11.4): destino novo, verificações, esquema informado, por fonte + conciliação com as referências do snapshot (= banco restaurado idêntico)
    const destino = path.join(raiz, 'restaurado');
    const referencias = { imagens: planejado.planos.imagens.referencias, 'fiscalizacao-pacotes': planejado.planos['fiscalizacao-pacotes'].referencias };
    const rest = await CP.restaurarL2({ pacote: preparacao, destino, fonteDeChaves: fonte(), layoutMinimo: 2, maxBytesPorArquivo: 1024 * 1024, referencias, esquema: postgres.esquema.compatibilidade, catalogo });
    assert.equal(rest.ok, true, JSON.stringify(rest));
    assert.deepEqual(rest.veredito, { classe: 'INTEGRO', motivos: [], recuperavelEmProducao: false, restauracaoReal: false });
    assert.deepEqual(rest.ordem.concluidos, ['DESTINO_NOVO', 'VERIFICACOES_8_7', 'BANCO_E_ESQUEMA', 'VERIFICADOR_POR_FONTE', 'RESULTADO']);
    assert.equal(rest.fontes.imagens.restaurados, 5);
    assert.equal(rest.fontes['fiscalizacao-pacotes'].conciliacao.classe, 'INTEGRO');
    assert.equal(sha(fs.readFileSync(path.join(destino, 'arquivos', 'imagens', ...img.chaves.pm.split('/')))), img.padrao[0].sha256);
    assert.equal(rest.recuperavelEmProducao, false);
    // destino existente => recusa no passo 1, nada tocado
    const denovo = await CP.restaurarL2({ pacote: preparacao, destino, fonteDeChaves: fonte(), layoutMinimo: 2, maxBytesPorArquivo: 1024, referencias, esquema: { relacao: 'IGUAL' }, catalogo });
    assert.deepEqual([denovo.ok, denovo.falha], [false, { passo: 'DESTINO_NOVO', codigo: 'DESTINO_EXISTENTE' }]);
    // referência a mais no banco (linha sem arquivo, F2) => INCOMPLETO; hash diferente (F10) => INCONSISTENTE; esquema à frente (F12) => INCONSISTENTE
    const comLinhaExtra = { ...referencias, imagens: [...referencias.imagens, { chave: `9/${'e'.repeat(64)}/mestre.png`, sha256: 'e'.repeat(64), bytes: 1, empresaId: '9' }] };
    const incompleto = await CP.restaurarL2({ pacote: preparacao, destino: path.join(raiz, 'r2'), fonteDeChaves: fonte(), layoutMinimo: 2, maxBytesPorArquivo: 1024, referencias: comLinhaExtra, esquema: { relacao: 'IGUAL' }, catalogo });
    assert.deepEqual([incompleto.ok, incompleto.veredito.classe, incompleto.fontes.imagens.conciliacao.divergencias[0].falha], [false, 'INCOMPLETO', 'F2']);
    const aFrente = await CP.restaurarL2({ pacote: preparacao, destino: path.join(raiz, 'r3'), fonteDeChaves: fonte(), layoutMinimo: 2, maxBytesPorArquivo: 1024, referencias, esquema: { relacao: 'BANCO_A_FRENTE_DO_CODIGO' }, catalogo });
    assert.deepEqual([aFrente.ok, aFrente.veredito.classe, aFrente.veredito.motivos.includes('ESQUEMA_BANCO_A_FRENTE_DO_CODIGO')], [false, 'INCONSISTENTE', true]);
    const semRefs = await CP.restaurarL2({ pacote: preparacao, destino: path.join(raiz, 'r4'), fonteDeChaves: fonte(), layoutMinimo: 2, maxBytesPorArquivo: 1024, esquema: { relacao: 'IGUAL' }, catalogo });
    assert.deepEqual([semRefs.ok, semRefs.veredito.classe, semRefs.fontes.imagens.motivo], [false, 'INCOMPLETO', 'REFERENCIAS_NAO_INFORMADAS']);
  });

  test('P6-03 — falhas fechadas da composição: origem ausente, fonte sem adaptador, área inválida, cópia divergente (F6), manifesto adulterado no pacote (8.7), chave revogada', async () => {
    const raiz = novaRaiz();
    const img = await montarImagens(raiz);
    const fis = await montarFiscalizacao(raiz);
    const catalogo = obterCatalogo();
    const executor = executorFalso({ padrao: img.padrao, empresa: img.empresa, pacotes: fis.linhas });
    const planejado = await CP.planejarNoSnapshot({ executor, catalogo, fontes: ['imagens', 'fiscalizacao-pacotes'] });
    const composicao = CP.criarComposicaoL2({ catalogo, fonteDeChaves: fonte(), chaveId: 'chave-teste-1', maxBytesPorArquivo: 1024 * 1024 });
    const base = { banco: { nome: 'gepi_sint', oid: '16384' }, conjuntoId: 'c', dump: { bytes: 1, sha256: 'a'.repeat(64) }, contexto: {}, postgres: C.blocoN0() };
    const prep = () => { const p = path.join(raiz, `p${crypto.randomBytes(3).toString('hex')}`); fs.mkdirSync(p, { mode: 0o700 }); return p; };
    assert.deepEqual((await composicao.compor({ ...base, preparacao: prep(), planos: planejado.planos, origens: { imagens: img.arm } })).falha, { estagio: 'ENTRADA', codigo: 'ORIGEM_AUSENTE' });
    assert.deepEqual((await composicao.compor({ ...base, preparacao: prep(), planos: { 'email-arquivo': { plano: [] } }, origens: { 'email-arquivo': {} } })).falha, { estagio: 'ENTRADA', codigo: 'ADAPTADOR_INDISPONIVEL' });
    assert.deepEqual((await composicao.compor({ ...base, preparacao: path.join(raiz, 'nao-existe'), planos: planejado.planos, origens: { imagens: img.arm, 'fiscalizacao-pacotes': fis.arm } })).falha, { estagio: 'AREA', codigo: 'AREA_INVALIDA' });
    // F6: corrupção em repouso na origem => INTEGRIDADE_DIVERGENTE, nada selado
    const corrompida = path.join(fis.dir, '7', 'pacote-3.zip');
    fs.writeFileSync(corrompida, Buffer.from('PK-corrompido-00'));
    const p = prep();
    const f6 = await composicao.compor({ ...base, preparacao: p, planos: planejado.planos, origens: { imagens: img.arm, 'fiscalizacao-pacotes': fis.arm } });
    assert.deepEqual(f6.falha, { estagio: 'COPIA', codigo: 'INTEGRIDADE_DIVERGENTE' });
    assert.ok(!fs.existsSync(path.join(p, 'manifesto.json')));
    fs.writeFileSync(corrompida, fis.zip);
    // pacote adulterado depois de selado: a restauração para nas verificações 8.7
    const p2 = prep(); fs.mkdirSync(path.join(p2, 'dump'), { mode: 0o700 }); fs.writeFileSync(path.join(p2, 'dump', 'postgres.dump'), Buffer.from('d'), { mode: 0o600 });
    const ok = await composicao.compor({ ...base, dump: { bytes: 1, sha256: sha(Buffer.from('d')) }, preparacao: p2, planos: planejado.planos, origens: { imagens: img.arm, 'fiscalizacao-pacotes': fis.arm } });
    assert.equal(ok.ok, true, JSON.stringify(ok.falha));
    fs.writeFileSync(path.join(p2, 'arquivos', 'fiscalizacao-pacotes', '7', 'pacote-3.zip'), Buffer.from('PK-corrompido-00'));
    const adulterado = await CP.restaurarL2({ pacote: p2, destino: path.join(raiz, 'r5'), fonteDeChaves: fonte(), layoutMinimo: 2, maxBytesPorArquivo: 1024, esquema: { relacao: 'IGUAL' }, catalogo });
    assert.deepEqual([adulterado.ok, adulterado.falha], [false, { passo: 'VERIFICACOES_8_7', codigo: 'ARQUIVO_DIVERGENTE' }]);
    assert.ok(fs.existsSync(path.join(raiz, 'r5')) && fs.readdirSync(path.join(raiz, 'r5')).length === 0, 'destino novo fica vazio; nada é apagado nem gravado');
    // chave revogada na leitura => selagem inválida
    const revogada = H.criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'chave-teste-1', segredo: SEG, revogada: true }] });
    const semChave = await CP.restaurarL2({ pacote: p2, destino: path.join(raiz, 'r6'), fonteDeChaves: revogada, layoutMinimo: 2, maxBytesPorArquivo: 1024, esquema: { relacao: 'IGUAL' }, catalogo });
    assert.deepEqual(semChave.falha, { passo: 'VERIFICACOES_8_7', codigo: 'SELAGEM_INVALIDA' });
    assert.throws(() => CP.criarComposicaoL2({ catalogo, fonteDeChaves: {}, chaveId: 'x', maxBytesPorArquivo: 1 }), (e) => e.code === 'ENTRADA_INVALIDA');
  });

  test('P6-04 — bloco postgres do snapshot: sem inventário ou sem sumário => N0 com motivo; com os dois => avaliação do P4', () => {
    assert.deepEqual(CP.avaliarPostgresDoSnapshot({ inventario: null, leitorDeSumario: null, migrationsDoCodigo: [] }).motivos, ['INVENTARIO_NAO_LIDO']);
    const inventario = { relacoes: [], outros: {}, extensoes: [], servidor: { versao: '16.4', encoding: 'UTF8', collate: 'C', ctype: 'C' }, migrations: ['000_a'] };
    assert.deepEqual(CP.avaliarPostgresDoSnapshot({ inventario, leitorDeSumario: null, migrationsDoCodigo: ['000_a'] }).motivos, ['SUMARIO_NAO_CAPTURADO']);
    const captura = CP.criarCapturaDeSumario();
    captura.alimentar(';     TOC Entries: 0\n;     Format: CUSTOM\n');
    const bloco = CP.avaliarPostgresDoSnapshot({ inventario, leitorDeSumario: captura, migrationsDoCodigo: ['000_a'] });
    assert.equal(bloco.nivelCalculado, 'N0');
    assert.ok(bloco.motivos.includes('SUMARIO_VAZIO'));
  });
});
