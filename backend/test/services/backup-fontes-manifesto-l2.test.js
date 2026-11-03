'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const M = require('../../src/services/backup-fontes-manifesto-l2.service');
const R = require('../../src/services/backup-fontes-regras.service');
const C = require('../../src/services/backup-fontes-postgres-cobertura.service');
const { obterCatalogo } = require('../../src/services/backup-fontes-catalogo.service');
const H = require('../../src/services/imagem-backup-manifesto-autenticado.service');
const { construirManifesto } = require('../../src/services/imagem-backup-manifesto.service');

/** D-ORF-6, P5 — manifesto evolutivo layout 2: escrita canônica, leitura em ordem obrigatória, compatibilidade com layout 1, anti-rebaixamento, limites e coerência da cobertura. Tudo puro. */

const SEG = crypto.randomBytes(32);
const SEG2 = crypto.randomBytes(32);
const fonte = (extra = {}) => H.criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'chave-teste-1', segredo: SEG, ...extra }] });
const hex = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const IMG = (empresa, h, nome) => `${empresa}/${h}/${nome}`;
const ARQUIVOS_IMAGENS = [
  { chave: IMG('7', hex('a'), 'mestre.png'), sha256: hex('a'), bytes: 100 },
  { chave: IMG('7', hex('a'), 'exibicao.webp'), sha256: hex('b'), bytes: 50 },
  { chave: IMG('padrao', hex('c'), 'miniatura.webp'), sha256: hex('d'), bytes: 20 },
];
const ZIPS = [{ chave: '7/pacote-3.zip', sha256: hex('e'), bytes: 1234 }];
const entradaBase = (extra = {}) => ({
  banco: { nome: 'gepi_sint', oid: '16384' }, conjuntoId: 'conjunto-sint-1', dump: { bytes: 4096, sha256: hex('f') },
  catalogo: obterCatalogo(), fontes: [{ id: 'imagens', arquivos: ARQUIVOS_IMAGENS }, { id: 'fiscalizacao-pacotes', arquivos: ZIPS }],
  contexto: { raizesConfiguradas: ['FISCALIZACAO_ARMAZENAMENTO_DIRETORIO'], resultadosDinamicos: { imagens: 'APROVADO' } }, postgres: C.blocoN0(), ...extra,
});
const escritor = () => M.criarEscritorL2({ fonteDeChaves: fonte(), chaveId: 'chave-teste-1' });
const leitor = (opcoes = {}) => M.criarLeitorL2({ fonteDeChaves: fonte(), layoutMinimo: 2, ...opcoes });
const motivo = (m) => (e) => e instanceof Error && e.code === 'MANIFESTO_INVALIDO' && e.motivo === m && !/sint|chave-teste|[0-9a-f]{64}/.test(e.message);
const entradaRuim = (m) => (e) => e instanceof TypeError && e.code === 'ENTRADA_INVALIDA' && e.motivo === m;

/** Assina um objeto arbitrário com a chave de teste e o domínio L2 (só para forjar entradas do leitor). */
function assinar(objeto, segredo = SEG, dominio = M.DOMINIO) {
  const semMac = M.serializarCanonico({ ...objeto, autenticacao: { algoritmo: 'HMAC-SHA256', chaveId: 'chave-teste-1' } });
  const mac = crypto.createHmac('sha256', segredo).update(dominio).update(semMac).digest('hex');
  const bytes = M.serializarCanonico({ ...objeto, autenticacao: { algoritmo: 'HMAC-SHA256', chaveId: 'chave-teste-1', mac } });
  return { bytes, sha256: sha(bytes) };
}
const corpoDe = (lido) => JSON.parse(lido.bytes.toString('utf8'));

describe('[ML] escritor e leitor do layout 2', () => {
  test('ML-01 — construir + ler: canônico (chaves ordenadas em todo nível), fontes ordenadas com totais, catálogo projetado dentro do MAC, bloco postgres, resultado congelado e reconhecido', () => {
    const escrito = escritor().construir(entradaBase());
    assert.equal(escrito.layout, 2);
    assert.equal(escrito.manifesto.versao, 2);
    assert.deepEqual(Object.keys(escrito.manifesto), [...M.CHAVES.raiz]);
    assert.deepEqual(Object.keys(escrito.manifesto.cobertura), [...M.CHAVES.cobertura]);
    assert.equal(escrito.bytes.equals(M.serializarCanonico(escrito.manifesto)), true, 'bytes são a serialização canônica do próprio objeto');
    assert.deepEqual(escrito.fontes.map((f) => f.id), ['fiscalizacao-pacotes', 'imagens']);
    assert.deepEqual(escrito.fontes[1].total, { arquivos: 3, bytes: 170 });
    assert.deepEqual(escrito.fontes[1].arquivos.map((a) => a.chave), [...ARQUIVOS_IMAGENS].map((a) => a.chave).sort());
    assert.equal(escrito.manifesto.cobertura.catalogo.sha256, R.hashCatalogo(obterCatalogo()));
    assert.equal(escrito.manifesto.cobertura.catalogo.fontes.length, obterCatalogo().fontes.length, 'TODAS as fontes do catálogo, inclusive pendentes e excluídas');
    assert.equal(escrito.manifesto.cobertura.declaracao, 'NAO_COMPROVADA');
    assert.ok(escrito.manifesto.cobertura.motivos.includes('NENHUMA_FONTE_COMPROVADA') && escrito.manifesto.cobertura.motivos.includes('PENDENCIA:imagens'));
    assert.ok(escrito.manifesto.cobertura.excluidas.length >= 4 && escrito.manifesto.cobertura.excluidas.every((e) => typeof e.relevancia === 'string'));
    assert.deepEqual(escrito.manifesto.cobertura.universo, { raizesConfiguradas: ['FISCALIZACAO_ARMAZENAMENTO_DIRETORIO'], raizesSemRegistro: [] });
    assert.deepEqual(escrito.manifesto.cobertura.verificacoes, { imagens: 'APROVADO' });
    assert.equal(escrito.postgres.nivelAtingido, 'N0');
    assert.equal(escrito.manifesto.dump.arquivo, 'dump/postgres.dump');
    assert.equal(escrito.caminhoDe('imagens', ARQUIVOS_IMAGENS[0].chave), `arquivos/imagens/${ARQUIVOS_IMAGENS[0].chave}`);
    assert.equal(escrito.caminhoDe('imagens', 'x'), null);
    assert.ok(Object.isFrozen(escrito) && Object.isFrozen(escrito.manifesto.cobertura.catalogo.fontes) && M.ehResultadoDoLeitor(escrito));
    assert.ok(!/\/Users|\/private|\/tmp|senha|password|PGPASS|secret/i.test(JSON.stringify(escrito.manifesto)), 'nenhum caminho ou credencial');

    const lido = leitor()({ bytes: escrito.bytes, sha256: escrito.sha256 });
    assert.deepEqual(lido.manifesto, escrito.manifesto);
    assert.equal(lido.identidade.sha256Manifesto, escrito.sha256);
    assert.deepEqual(lido.autenticacao, { versao: 2, layout: 2, autenticado: true, algoritmo: 'HMAC-SHA256', chaveId: 'chave-teste-1', origemDaChave: 'TESTE_CONTROLADO' });
    assert.deepEqual(lido.avisos, ['CHAVE_NAO_OPERACIONAL', 'NIVEL_N0']);
    assert.equal(lido.catalogoAtualDiverge, null);
    const bufA = lido.bytes; bufA[0] = 0; assert.notEqual(lido.bytes[0], 0, 'bytes é cópia nova a cada acesso');
  });

  test('ML-02 — ordem obrigatória de leitura: hash, JSON, versão, layout ≥ mínimo, autenticação, chave, MAC; nenhuma estrutura é lida antes do MAC', () => {
    const escrito = escritor().construir(entradaBase());
    const ler = leitor();
    assert.throws(() => ler({ bytes: escrito.bytes, sha256: hex('0') }), motivo('HASH_DIVERGENTE'));
    const lixo = Buffer.from('{nao json', 'utf8');
    assert.throws(() => ler({ bytes: lixo, sha256: sha(lixo) }), motivo('ESTRUTURA_INVALIDA'));
    const v1 = Buffer.from('{"versao":1}', 'utf8');
    assert.throws(() => ler({ bytes: v1, sha256: sha(v1) }), motivo('VERSAO_NAO_AUTENTICADA'));
    const v3 = Buffer.from('{"versao":3}', 'utf8');
    assert.throws(() => ler({ bytes: v3, sha256: sha(v3) }), motivo('VERSAO_DESCONHECIDA'));
    const l9 = Buffer.from('{"layout":9,"versao":2}', 'utf8');
    assert.throws(() => ler({ bytes: l9, sha256: sha(l9) }), motivo('LAYOUT_DESCONHECIDO'));
    const semAuth = Buffer.from('{"layout":2,"versao":2}', 'utf8');
    assert.throws(() => ler({ bytes: semAuth, sha256: sha(semAuth) }), motivo('AUTENTICACAO_AUSENTE'));
    const algo = assinar({ layout: 2, versao: 2 });
    const algoRuim = Buffer.from(algo.bytes.toString('utf8').replace('HMAC-SHA256', 'HMAC-SHA512'), 'utf8');
    assert.throws(() => ler({ bytes: algoRuim, sha256: sha(algoRuim) }), motivo('ALGORITMO_INVALIDO'));
    // estrutura inválida mas MAC válido: o motivo é de ESTRUTURA (chegou ao passo 6); MAC inválido com estrutura perfeita: MAC_INVALIDO (nunca estrutura antes)
    assert.throws(() => ler(algo), motivo('CAMPO_AUSENTE'));
    const forjado = assinar(JSON.parse(escrito.bytes.toString('utf8')), SEG2);
    assert.throws(() => ler(forjado), motivo('MAC_INVALIDO'));
    // chave: indisponível, revogada, fonte que lança
    const semChave = M.criarLeitorL2({ fonteDeChaves: H.criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'outra', segredo: SEG }] }), layoutMinimo: 2 });
    assert.throws(() => semChave({ bytes: escrito.bytes, sha256: escrito.sha256 }), motivo('CHAVE_INDISPONIVEL'));
    const revogada = M.criarLeitorL2({ fonteDeChaves: fonte({ revogada: true }), layoutMinimo: 2 });
    assert.throws(() => revogada({ bytes: escrito.bytes, sha256: escrito.sha256 }), motivo('CHAVE_REVOGADA'));
    let consultas = 0;
    const contadora = H.criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: { obter() { consultas += 1; throw new Error('x'); } } });
    assert.throws(() => M.criarLeitorL2({ fonteDeChaves: contadora, layoutMinimo: 2 })({ bytes: l9, sha256: sha(l9) }), motivo('LAYOUT_DESCONHECIDO'));
    assert.equal(consultas, 0, 'layout inválido é recusado antes de consultar a chave');
    assert.throws(() => M.criarLeitorL2({ fonteDeChaves: contadora, layoutMinimo: 2 })({ bytes: escrito.bytes, sha256: escrito.sha256 }), motivo('CHAVE_INDISPONIVEL'));
    assert.equal(consultas, 1);
    assert.throws(() => M.criarLeitorL2({ fonteDeChaves: fonte(), layoutMinimo: 3 }), entradaRuim('LEITOR_INVALIDO'));
    assert.throws(() => M.criarLeitorL2({ fonteDeChaves: { obter() {} }, layoutMinimo: 2 }), entradaRuim('LEITOR_INVALIDO'));
  });

  test('ML-03 — anti-rebaixamento e domínio de MAC: L1 autêntico é recusado quando a operação exige L2; MAC do domínio L1 não vale em L2 e vice-versa; mudar layout quebra o MAC', () => {
    const escrito = escritor().construir(entradaBase());
    // L1 autêntico construído pelos módulos históricos
    const v1 = construirManifesto({ contexto: { banco: { nome: 'gepi_sint', oid: '16384' }, plano: ARQUIVOS_IMAGENS.map((a) => ({ chave: a.chave, sha256: a.sha256 })) },
      copia: { ok: true, completo: true, falha: null, copiados: 3, arquivos: ARQUIVOS_IMAGENS.map((a) => ({ chave: a.chave, sha256: a.sha256, bytes: a.bytes })) },
      dump: { concluido: true, bytes: 4096, sha256Declarado: hex('f'), sha256Recalculado: hex('f') }, conjuntoId: 'conjunto-sint-1' });
    const l1 = H.criarAutenticador({ fonteDeChaves: fonte(), chaveId: 'chave-teste-1' }).autenticar(v1);
    assert.throws(() => leitor()({ bytes: l1.bytes, sha256: l1.sha256 }), motivo('LAYOUT_INSUFICIENTE'));
    const normalizado = leitor({ layoutMinimo: 1 })({ bytes: l1.bytes, sha256: l1.sha256 });
    assert.equal(normalizado.layout, 1);
    assert.deepEqual(normalizado.fontes.map((f) => [f.id, f.versaoContrato, f.total.arquivos, f.total.bytes]), [['imagens', 1, 3, 170]]);
    assert.equal(normalizado.cobertura, null);
    assert.deepEqual(normalizado.postgres, C.blocoN0('LAYOUT_1'));
    assert.deepEqual(normalizado.avisos, ['COBERTURA_NAO_DECLARADA', 'NIVEL_N0']);
    assert.equal(normalizado.caminhoDe('imagens', ARQUIVOS_IMAGENS[0].chave), `imagens/${ARQUIVOS_IMAGENS[0].chave}`);
    assert.equal(normalizado.autenticacao.layout, 1);
    assert.ok(M.ehResultadoDoLeitor(normalizado));
    // domínio: assinar o corpo L2 com o domínio do L1 (ou um L1 com o domínio do L2) não autentica
    const corpo = corpoDe(escrito);
    const comDominioL1 = assinar(corpo, SEG, Buffer.from('SAFEWORK-BACKUP-MANIFESTO-V2\n', 'utf8'));
    assert.throws(() => leitor()(comDominioL1), motivo('MAC_INVALIDO'));
    const l1Objeto = JSON.parse(l1.bytes.toString('utf8'));
    const l1ComDominioL2 = assinar(l1Objeto, SEG, M.DOMINIO);
    assert.throws(() => leitor({ layoutMinimo: 1 })(l1ComDominioL2), motivo('MAC_INVALIDO'));
    // rebaixar o campo layout de um L2 assinado: o MAC cobre o layout
    const rebaixado = Buffer.from(escrito.bytes.toString('utf8').replace('"layout":2', '"layout":1'), 'utf8');
    assert.throws(() => leitor({ layoutMinimo: 1 })({ bytes: rebaixado, sha256: sha(rebaixado) }), motivo('MAC_INVALIDO'));
  });

  test('ML-04 — golden: manifesto V2/layout 1 real da evidência E4 (cópia somente leitura) tem o MESMO resultado no leitor histórico e no leitor novo; com layout mínimo 2 é recusado antes da chave', () => {
    const bytes = fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'd-orf-6-e4-manifesto-v2-l1.json'));
    const sha256 = sha(bytes);
    assert.equal(sha256, 'f21906d5d72be983284c18dd817427d8b1a9922f22b72f8133ad9176d7042ad8', 'cópia idêntica ao manifesto.sha256 da evidência');
    const objeto = JSON.parse(bytes.toString('utf8'));
    assert.deepEqual([objeto.versao, objeto.layout, objeto.autenticacao.chaveId, objeto.arquivos.length], [2, 1, 'chave-hom-1', 11]);
    // a chave de homologação não está disponível aqui: os dois leitores recusam pelo MESMO motivo, sem ler a estrutura
    const semChave = fonte();
    let historico;
    let novo;
    try { H.criarLeitorV2({ fonteDeChaves: semChave })({ bytes, sha256 }); } catch (e) { historico = e.motivo; }
    try { leitor({ layoutMinimo: 1, fonteDeChaves: semChave })({ bytes, sha256 }); } catch (e) { novo = e.motivo; }
    assert.equal(historico, 'CHAVE_INDISPONIVEL');
    assert.equal(novo, historico);
    // com a chave "certa" simulada (id igual, segredo desconhecido) o resultado continua idêntico: MAC_INVALIDO nos dois
    const chaveHom = H.criarFonteDeChaves({ origem: 'TESTE_CONTROLADO', chaves: [{ id: 'chave-hom-1', segredo: SEG }] });
    try { H.criarLeitorV2({ fonteDeChaves: chaveHom })({ bytes, sha256 }); } catch (e) { historico = e.motivo; }
    try { leitor({ layoutMinimo: 1, fonteDeChaves: chaveHom })({ bytes, sha256 }); } catch (e) { novo = e.motivo; }
    assert.equal(historico, 'MAC_INVALIDO');
    assert.equal(novo, historico);
    let consultas = 0;
    const contadora = H.criarFonteDeProvedor({ origem: 'TESTE_CONTROLADO', provedor: { obter() { consultas += 1; return { situacao: 'INDISPONIVEL' }; } } });
    assert.throws(() => M.criarLeitorL2({ fonteDeChaves: contadora, layoutMinimo: 2 })({ bytes, sha256 }), motivo('LAYOUT_INSUFICIENTE'));
    assert.equal(consultas, 0);
  });

  test('ML-05 — falha fechada na estrutura (após MAC válido): campo desconhecido/ausente em cada nível, formato de chave da fonte, fonte não catalogada, comportamento não suportado, fonte incluída sem dados, bloco postgres inválido, ordem não canônica e chave JSON duplicada', () => {
    const escrito = escritor().construir(entradaBase());
    const corpo = corpoDe(escrito);
    const ler = leitor();
    const mutar = (fn) => { const o = structuredClone(corpo); fn(o); return assinar(o); };
    assert.throws(() => ler(mutar((o) => { o.extra = 1; })), motivo('CAMPO_DESCONHECIDO'));
    assert.throws(() => ler(mutar((o) => { delete o.banco; })), motivo('CAMPO_AUSENTE'));
    assert.throws(() => ler(mutar((o) => { o.cobertura.extra = 1; })), motivo('CAMPO_DESCONHECIDO'));
    assert.throws(() => ler(mutar((o) => { delete o.cobertura.universo; })), motivo('CAMPO_AUSENTE'));
    assert.throws(() => ler(mutar((o) => { o.cobertura.catalogo.fontes[0].extra = 1; })), motivo('CAMPO_DESCONHECIDO'));
    assert.throws(() => ler(mutar((o) => { o.fontes[0].arquivos[0].caminho = '/x'; })), motivo('CAMPO_DESCONHECIDO'));
    assert.throws(() => ler(mutar((o) => { o.cobertura.postgres.extra = 1; })), motivo('CAMPO_DESCONHECIDO'));
    assert.throws(() => ler(mutar((o) => { delete o.cobertura.postgres.esquema; })), motivo('POSTGRES_INVALIDO'));
    assert.throws(() => ler(mutar((o) => { o.cobertura.postgres.nivelAtingido = 'N1'; })), motivo('POSTGRES_INVALIDO'), 'null fora do N0');
    assert.throws(() => ler(mutar((o) => { o.dump.arquivo = 'dump/outro.dump'; })), motivo('CAMINHO_DO_DUMP_INVALIDO'));
    assert.throws(() => ler(mutar((o) => { o.fontes[1].arquivos[0].chave = '7/pacote-9.zip'; })), motivo('CHAVE_DE_ARQUIVO_INVALIDA'), 'chave de ZIP numa fonte de imagens');
    assert.throws(() => ler(mutar((o) => { o.fontes[0].id = 'desconhecida'; })), motivo('FONTE_NAO_CATALOGADA'));
    assert.throws(() => ler(mutar((o) => { o.cobertura.catalogo.fontes.find((f) => f.id === 'imagens').formatoChaveId = 'imagem-v9'; })), motivo('COMPORTAMENTO_NAO_SUPORTADO'));
    assert.throws(() => ler(mutar((o) => { o.cobertura.catalogo.fontes.find((f) => f.id === 'imagens').verificadorId = 'outro-v1'; })), motivo('COMPORTAMENTO_NAO_SUPORTADO'));
    assert.throws(() => ler(mutar((o) => {
      const f = o.cobertura.catalogo.fontes.find((x) => x.id === 'imagens'); f.estadoCobertura = 'PROTEGIDA_COMPROVADA'; f.incluida = true; f.motivo = null;
      const c = o.cobertura; const coerente = M.declararCobertura({ catalogo: c.catalogo, excluidas: c.excluidas, universo: c.universo, postgres: c.postgres, verificacoes: c.verificacoes });
      c.declaracao = coerente.declaracao; c.motivos = [...coerente.motivos]; // cobertura coerente: a única incoerência que resta é a fonte incluída sem dados
      o.fontes = o.fontes.filter((x) => x.id !== 'imagens');
    })), motivo('FONTE_INCLUIDA_AUSENTE'));
    assert.throws(() => ler(mutar((o) => { o.fontes[1].total.bytes += 1; })), motivo('ESTRUTURA_INVALIDA'));
    // ordem não canônica e chave duplicada: os bytes diferem da forma canônica (o MAC é calculado sobre a releitura, então só a forma única salva)
    const assinado = assinar(corpo);
    const texto = assinado.bytes.toString('utf8');
    const foraDeOrdem = Buffer.from(texto.replace('"layout":2,"versao":2}', '"versao":2,"layout":2}'), 'utf8');
    assert.throws(() => ler({ bytes: foraDeOrdem, sha256: sha(foraDeOrdem) }), motivo('ESTRUTURA_INVALIDA'));
    const duplicada = Buffer.from(texto.replace('"layout":2,"versao":2}', '"layout":2,"versao":2,"versao":2}'), 'utf8');
    assert.throws(() => ler({ bytes: duplicada, sha256: sha(duplicada) }), motivo('ESTRUTURA_INVALIDA'));
  });

  test('ML-06 — cobertura: declaração é função pura recomputada na leitura; declaração acima do teto = COBERTURA_INCOERENTE; a função pura coincide com as regras do catálogo', () => {
    const escrito = escritor().construir(entradaBase());
    const corpo = corpoDe(escrito);
    const ler = leitor();
    const completa = structuredClone(corpo); completa.cobertura.declaracao = 'COMPLETA';
    assert.throws(() => ler(assinar(completa)), motivo('COBERTURA_INCOERENTE'));
    const semMotivo = structuredClone(corpo); semMotivo.cobertura.motivos = semMotivo.cobertura.motivos.filter((m) => m !== 'NENHUMA_FONTE_COMPROVADA');
    assert.throws(() => ler(assinar(semMotivo)), motivo('COBERTURA_INCOERENTE'));
    const incluidaSemProva = structuredClone(corpo); incluidaSemProva.cobertura.catalogo.fontes.find((f) => f.id === 'imagens').incluida = true;
    assert.throws(() => ler(assinar(incluidaSemProva)), motivo('COBERTURA_INCOERENTE'));
    // a função pura reproduz avaliarCobertura para o catálogo real em vários contextos
    const catalogo = obterCatalogo();
    const projecao = R.projetarParaManifesto(catalogo);
    const excluidas = catalogo.fontes.filter((f) => f.classe === 'EXCLUIDA').map((f) => ({ fonteId: f.id, decisao: f.decisaoRef ?? null, relevancia: f.relevancia }));
    for (const ctx of [{}, { raizesConfiguradas: [] }, { raizesConfiguradas: ['X_INEXISTENTE_DIRETORIO'] }, { raizesConfiguradas: [], resultadosDinamicos: Object.fromEntries(catalogo.fontes.map((f) => [f.id, 'APROVADO'])) }]) {
      for (const nivel of ['N0', 'N1']) {
        const regras = R.avaliarCobertura(catalogo, { ...ctx, nivelPostgres: nivel });
        const registradas = new Set(catalogo.fontes.map((f) => f.raiz.variavel).filter((v) => v !== null));
        const universo = { raizesConfiguradas: ctx.raizesConfiguradas ?? null, raizesSemRegistro: (ctx.raizesConfiguradas ?? []).filter((n) => !registradas.has(n)) };
        const pura = M.declararCobertura({ catalogo: projecao, excluidas, universo, postgres: { nivelAtingido: nivel }, verificacoes: ctx.resultadosDinamicos ?? {} });
        assert.deepEqual([pura.declaracao, [...pura.motivos]], [regras.teto, [...regras.motivos]], JSON.stringify({ ctx, nivel }));
      }
    }
    assert.match(M.descreverDeclaracao('COMPLETA'), /em relação às fontes registradas e às guardas/);
    assert.match(M.descreverDeclaracao('NAO_COMPROVADA'), /não comprovada/);
    assert.throws(() => M.descreverDeclaracao('TOTAL'), entradaRuim('DECLARACAO_INVALIDA'));
  });

  test('ML-07 — catálogo por valor (DEC-6): o leitor decide só pelo catálogo embutido; o catálogo atual só gera informação; bloco postgres N1 real do P4 é aceito e remove o aviso NIVEL_N0', () => {
    const escrito = escritor().construir(entradaBase());
    const catalogoSintetico = { ...obterCatalogo(), versao: 2 };
    const comAtual = M.criarLeitorL2({ fonteDeChaves: fonte(), layoutMinimo: 2, catalogoAtual: catalogoSintetico })({ bytes: escrito.bytes, sha256: escrito.sha256 });
    const semAtual = leitor()({ bytes: escrito.bytes, sha256: escrito.sha256 });
    assert.equal(comAtual.catalogoAtualDiverge, true);
    assert.deepEqual(comAtual.manifesto, semAtual.manifesto);
    assert.deepEqual(comAtual.fontes, semAtual.fontes);
    assert.throws(() => M.criarLeitorL2({ fonteDeChaves: fonte(), layoutMinimo: 2, catalogoAtual: { versao: 1 } }), entradaRuim('CATALOGO_INVALIDO'));
    // bloco N1 (mesma forma do P4) embutido
    const S = require('../../src/services/backup-fontes-postgres-sumario.service');
    const inventario = { relacoes: [{ esquema: 'public', nome: 'empresas', relkind: 'r', sustentaRestricao: false, sequenciaImplicita: false }], outros: {}, extensoes: [], servidor: { versao: '16.4', encoding: 'UTF8', collate: 'C', ctype: 'C' }, migrations: ['000_a'] };
    const sumario = S.lerSumario(';     TOC Entries: 2\n;     Format: CUSTOM\n1; 1259 1 TABLE public empresas d\n2; 0 1 TABLE DATA public empresas d\n');
    const bloco = C.avaliarCoberturaPostgres({ inventario, sumario, migrationsDoCodigo: ['000_a'] });
    assert.equal(bloco.nivelAtingido, 'N1');
    const comN1 = escritor().construir(entradaBase({ postgres: bloco }));
    const lidoN1 = leitor()({ bytes: comN1.bytes, sha256: comN1.sha256 });
    assert.equal(lidoN1.postgres.nivelAtingido, 'N1');
    assert.deepEqual(lidoN1.avisos, ['CHAVE_NAO_OPERACIONAL']);
    assert.equal(lidoN1.cobertura.declaracao, 'NAO_COMPROVADA', 'N1 sozinho não comprova fonte alguma');
    assert.ok(!lidoN1.cobertura.motivos.some((m) => m.startsWith('NIVEL_POSTGRES')));
  });

  test('ML-08 — limites: manifesto acima de 64 MiB, mais fontes que o catálogo permite, arquivos por fonte e total, projeção do catálogo, textos longos', () => {
    const escrito = escritor().construir(entradaBase());
    const corpo = corpoDe(escrito);
    const ler = leitor();
    const grande = Buffer.alloc(M.LIMITES.bytesDoManifesto + 1, 0x20);
    assert.throws(() => ler({ bytes: grande, sha256: hex('0') }), motivo('LIMITE_EXCEDIDO'));
    const muitasFontes = structuredClone(corpo);
    for (let i = 0; i < M.LIMITES.fontes; i += 1) muitasFontes.fontes.push({ arquivos: [], id: `f${i}`, total: { arquivos: 0, bytes: 0 }, versaoContrato: 1 });
    assert.throws(() => ler(assinar(muitasFontes)), motivo('LIMITE_EXCEDIDO'));
    const conjuntoLongo = structuredClone(corpo); conjuntoLongo.conjuntoId = 'x'.repeat(M.LIMITES.texto + 1);
    assert.throws(() => ler(assinar(conjuntoLongo)), motivo('ESTRUTURA_INVALIDA'));
    const totalRuim = structuredClone(corpo); totalRuim.fontes[1].total.arquivos = M.LIMITES.arquivosPorFonte + 1;
    assert.throws(() => ler(assinar(totalRuim)), motivo('ESTRUTURA_INVALIDA'));
    assert.deepEqual(M.LIMITES, { bytesDoManifesto: 64 * 1024 * 1024, fontes: 16, arquivosPorFonte: 200000, arquivosTotal: 400000, texto: 200, projecaoBytes: 256 * 1024, motivos: 200 });
    assert.ok(M.serializarCanonico(corpo.cobertura.catalogo).length < M.LIMITES.projecaoBytes);
  });

  test('ML-09 — escritor: entrada inválida é TypeError ENTRADA_INVALIDA sem assinar nada (catálogo inválido, fonte não catalogada, fonte sem implementação, chave fora do formato, dump incoerente, contexto estranho, chave revogada)', () => {
    const e = escritor();
    assert.throws(() => e.construir(entradaBase({ catalogo: { versao: 1, fontes: [] } })), entradaRuim('CATALOGO_INVALIDO'));
    assert.throws(() => e.construir(entradaBase({ fontes: [{ id: 'nao-existe', arquivos: [] }] })), entradaRuim('FONTE_NAO_CATALOGADA'));
    assert.throws(() => e.construir(entradaBase({ fontes: [{ id: 'postgres-aplicacao', arquivos: [] }] })), entradaRuim('FONTE_INVALIDA'));
    assert.throws(() => e.construir(entradaBase({ fontes: [{ id: 'imagens', arquivos: [{ chave: '../x', sha256: hex('a'), bytes: 1 }] }] })), entradaRuim('CHAVE_DE_ARQUIVO_INVALIDA'));
    assert.throws(() => e.construir(entradaBase({ dump: { bytes: 0, sha256: hex('f') } })), entradaRuim('ESTRUTURA_INVALIDA'));
    assert.throws(() => e.construir(entradaBase({ contexto: { outra: 1 } })), entradaRuim('CONTEXTO_INVALIDO'));
    assert.throws(() => e.construir(entradaBase({ contexto: { resultadosDinamicos: { inexistente: 'APROVADO' } } })), entradaRuim('CONTEXTO_INVALIDO'));
    assert.throws(() => e.construir(entradaBase({ postgres: { nivelAtingido: 'N1' } })), entradaRuim('POSTGRES_INVALIDO'), 'bloco postgres fora do contrato v1');
    assert.throws(() => e.construir(entradaBase({ postgres: { ...C.blocoN0(), nivelAtingido: 'N9' } })), entradaRuim('CONTEXTO_INVALIDO'), 'nível desconhecido é recusado pelas regras do catálogo');
    assert.throws(() => e.construir({ ...entradaBase(), extra: 1 }), entradaRuim('ENTRADA'));
    assert.throws(() => M.criarEscritorL2({ fonteDeChaves: fonte({ revogada: true }), chaveId: 'chave-teste-1' }), entradaRuim('CHAVE_INDISPONIVEL'));
    assert.throws(() => M.criarEscritorL2({ fonteDeChaves: fonte(), chaveId: 'a b' }), entradaRuim('FONTE_INVALIDA'));
    // mesmo conteúdo => mesmos bytes (determinismo), independentemente da ordem de entrada
    const a = e.construir(entradaBase());
    const b = e.construir(entradaBase({ fontes: [...entradaBase().fontes].reverse() }));
    assert.ok(a.bytes.equals(b.bytes));
  });
});
