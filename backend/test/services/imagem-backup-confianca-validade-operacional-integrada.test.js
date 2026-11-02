'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { lerConfiguracao } = require('../../src/config/imagens');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { criarSelagem } = require('../../src/services/imagem-backup-selagem.service');
const { avaliarConjunto, SAIDAS, ESTADOS_DA_JANELA, ESTADOS_DA_FINALIZACAO } = require('../../src/services/imagem-backup.service');
const { reconhecerCorrelacao, avaliarCorrelacao } = require('../../src/services/imagem-backup-correlacao.service');
const { criarInicializacaoConfiavel, executarBackupEncadeado } = require('../../src/services/imagem-backup-encadeamento-confiavel-integrado.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, CONFIANÇA E VALIDADE, MARCO B), RECONCILIADO com os contratos aprovados E1, E2, E3' e E4. Só dados FICTÍCIOS em diretórios temporários exclusivos
 * (prefixo `gepi-val-test-`). Simulados e identificados: PostgreSQL, `pg_dump`, trava, inicialização operacional e declaração do dump. Reais: encadeamento aprovado, coordenador, supervisor, observador (T1/T2),
 * correlação (E4), aquisição, montagem, composição, selagem e o avaliador. Nada aqui executa `pg_dump`/`pg_restore`, faz backup real ou comprova confiança operacional.
 *
 * RECONCILIAÇÃO (autorizada): a primeira versão deste arquivo especificava um módulo de "validade operacional" (`imagem-backup-validade-operacional.service.js`: contexto de validade, relatório próprio,
 * verificador estrutural simulado) cuja arquitetura foi REJEITADA e que NÃO foi implementado. Cada cenário foi mantido (mesmo ID, mesma garantia) e reexpresso nos contratos efetivos. Nenhum cenário foi removido,
 * desabilitado nem convertido em TODO por conveniência; as garantias que dependem de capacidade ainda inexistente continuam registradas em [PENDÊNCIAS] (estrutural real, fonte independente do hash, inicialização operacional).
 *
 * RASTREABILIDADE (teste original -> garantia protegida -> contrato atual -> expectativa corrigida -> evidência):
 *  CTL-01   terminal do supervisor / avaliação fechada / composição íntegra -> `coordenador.supervisao` + `correlacao.supervisao`; o terminal AGORA chega à avaliação (E2); o resultado do encadeamento ganha a chave aditiva `correlacao`.
 *  CTL-02   falhas do supervisor distinguidas e sem cópia/preparação -> inalterado.
 *  CTL-03   avaliador legado é comparador sem proveniência -> inalterado como CARACTERIZAÇÃO do resíduo; o caminho integrado exige `correlacao` reconhecida e nunca promove a válido (V-01, V-05).
 *  V-01     fluxo positivo integrado -> o "relatório de oito condições" foi substituído por condições DERIVADAS das evidências reais (coordenação, procedimento, T1, T2, imagens, manifesto, selagem) + correlação CONJUNTO;
 *           `valido:false`, `recuperavel:false`, estrutura NÃO executada. Sem produtor de relatório operacional.
 *  V-02     falhas do procedimento e da evidência -> mesmos sete cenários; avaliação fechada, correlação do conjunto NÃO formada, diagnósticos preservados, nada publicado.
 *  V-03     hash correto não conclui a estrutura -> nenhum verificador estrutural arbitrário entra na cadeia (chave recusada) e a estrutura permanece NÃO executada; o hash/T1/T2 não promovem validade.
 *  V-04a/b  fronteira de confiança -> inicialização/execução do ENCADEAMENTO recusam avaliador, relatório, veredito, supervisão, declaração, origem, forjados e cópias rasas.
 *  V-05     autenticidade do relatório -> autenticidade da CORRELAÇÃO (origem reconhecida; clone, literal e cópia rasa não valem; uma operação não vale para outra).
 *  V-06a/b  concorrência e isolamento -> inalterado nas garantias, com correlações próprias por operação.
 *
 * ESCOPO: "contrato satisfeito com fontes SIMULADAS" NÃO é "confiança operacional real comprovada". Nada aqui é publicação, durabilidade ou recuperabilidade.
 */

const PRAZO = 30000;
const PREFIXO = 'gepi-val-test-';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const CONJUNTO = 'conjunto-val-0001';
const ID_SNAPSHOT = '00000003-0000001B-1';
const teste = (nome, fn) => test(nome, { timeout: PRAZO }, fn);
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DUMP_BYTES = Buffer.from('dump-ficticio-0123456789-'.repeat(120));
const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };
const CONDICOES = ['conferenciaT2', 'coordenacao', 'estrutura', 'evidenciaFisica', 'imagensFisicas', 'manifesto', 'procedimento', 'selagem'];
const CHAVES_DO_ENCADEAMENTO = ['aquisicao', 'composicao', 'coordenador', 'correlacao', 'evidenciaDoDump', 'pacote', 'publicacao', 'verificacao'];

// ------------------------------------------------------------------------------------------------------------------------------- infraestrutura SIMULADA
const raizes = [];
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of raizes) if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO)) fs.rmSync(p, { recursive: true, force: true });
});
const novaRaiz = () => { const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO))); fs.chmodSync(p, 0o700); raizes.push(p); return p; };
function tipoDe(sql) {
  const t = String(sql).replace(/\s+/g, ' ').trim();
  if (/^BEGIN\b/i.test(t)) return 'BEGIN';
  if (/^ROLLBACK\b/i.test(t)) return 'ROLLBACK';
  if (/pg_export_snapshot\(\)/.test(t)) return 'EXPORTAR';
  if (/current_database\(\)/.test(t)) return 'IDENTIDADE';
  if (/FROM imagens_padrao/.test(t)) return 'PADRAO';
  if (/FROM imagens_empresa/.test(t)) return 'EMPRESA';
  return `OUTRO:${t}`;
}
const paginar = (linhas, [depoisDe, limite]) => linhas.filter((l) => BigInt(l.id) > BigInt(depoisDe)).slice(0, limite);

/** Mundo SIMULADO (mesmo molde do encadeamento aprovado). */
async function mundo(opc = {}) {
  const raiz = novaRaiz();
  const linha = [];
  const buf = (t) => Buffer.from(t, 'utf8');
  const pm = buf('padrao-mestre-conteudo');
  const pn = buf('padrao-miniatura-conteudo');
  const em = buf('empresa7-mestre');
  const ee = buf('empresa7-exibicao');
  const en = buf('empresa7-miniatura');
  const registros = {
    padrao: [{ id: '1', sha256: sha(pm), sha256Miniatura: sha(pn), sha256Exibicao: null, formato: 'PNG', bytesMestre: pm.length, bytesMiniatura: pn.length, bytesExibicao: null }],
    empresa: [{ id: '2', empresaId: 7, sha256: H('c'), formato: 'PNG', sha256Mestre: sha(em), sha256Exibicao: sha(ee), sha256Miniatura: sha(en), bytesMestre: em.length, bytesExibicao: ee.length, bytesMiniatura: en.length }],
  };
  const linhasPadrao = [{ id: '1', sha256: sha(pm), sha256_miniatura: sha(pn), sha256_exibicao: null, formato: 'PNG', bytes_mestre: pm.length, bytes_miniatura: pn.length, bytes_exibicao: null }];
  const linhasEmpresa = [{ id: '2', empresa_id: 7, sha256: H('c'), sha256_mestre: sha(em), sha256_exibicao: sha(ee), sha256_miniatura: sha(en), formato: 'PNG', bytes_mestre: em.length, bytes_exibicao: ee.length, bytes_miniatura: en.length }];
  const plano = planejarArquivos(registros);
  const dirOrigem = path.join(raiz, 'origem');
  const origem = criarArmazenamentoImagens({ diretorio: dirOrigem });
  for (const item of plano) await origem.gravar(item.chave, [pm, pn, em, ee, en].find((c) => sha(c) === item.sha256), { maxBytes: 4096, sha256Esperado: item.sha256 });
  const pai = path.join(raiz, 'preparacoes');
  const dumps = path.join(raiz, 'dumps');
  fs.mkdirSync(pai, { mode: 0o700 });
  fs.mkdirSync(dumps, { mode: 0o700 });

  const estadoDaTrava = { documento: opc.ocupada ? { token: 'alheio' } : null, liberacoes: 0 };
  const janela = {
    async adquirir(argumentos) {
      linha.push('janela:adquirir');
      if (estadoDaTrava.documento !== null) {
        const { ErroDeJanela } = require('../../src/utils/janela-escrita-imagens');
        throw new ErroDeJanela('JANELA_OCUPADA', { tipo: 'LIMPEZA', pid: 4242, iniciadoEm: '2026-10-21T03:00:00.000Z' });
      }
      const token = `token-${linha.length}`;
      estadoDaTrava.documento = { token };
      return Object.freeze({
        tipo: argumentos.tipo,
        async confirmarPosse() { return { confirmada: estadoDaTrava.documento !== null && estadoDaTrava.documento.token === token }; },
        async liberar() { linha.push('janela:liberar'); estadoDaTrava.liberacoes += 1; if (estadoDaTrava.documento === null || estadoDaTrava.documento.token !== token) return { liberada: false }; estadoDaTrava.documento = null; return { liberada: true }; },
      });
    },
  };
  const criarCliente = () => {
    const c = {
      ouvintes: { error: [], end: [] },
      async connect() { linha.push('sql:connect'); },
      async query(sql, parametros) {
        const tipo = tipoDe(sql);
        linha.push(`sql:${tipo}`);
        switch (tipo) {
          case 'EXPORTAR': return { rows: [{ snapshot_id: ID_SNAPSHOT }] };
          case 'IDENTIDADE': return { rows: [{ nome: 'gestao_epi', oid: '16384' }] };
          case 'PADRAO': return { rows: paginar(linhasPadrao, parametros) };
          case 'EMPRESA': return { rows: paginar(linhasEmpresa, parametros) };
          default: return { rows: [] };
        }
      },
      async end() { linha.push('sql:end'); for (const f of c.ouvintes.end) f(); },
      on(evento, ouvinte) { (c.ouvintes[evento] ??= []).push(ouvinte); return c; },
    };
    return c;
  };
  const arquivos = {
    criarExclusivo(spec) {
      const descritor = fs.openSync(path.join(spec.diretorio, spec.nome), fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, spec.modo);
      let fechado = false;
      return { descritor, fechar() { if (!fechado) { fechado = true; fs.closeSync(descritor); } } };
    },
  };
  const lancador = {
    lancar(spec) {
      linha.push('dump:lancado');
      if (!opc.semBytes) fs.writeSync(spec.opcoes.stdio[1], DUMP_BYTES);
      return { pid: 4242, saida: Promise.resolve(opc.termino ?? { codigo: 0, sinal: null }), fluxosFechados: Promise.resolve() };
    },
  };
  const dump = {
    alvo: { executavel: '/usr/bin/pg_dump', host: '127.0.0.1', porta: 5432, usuario: 'gepi', arquivoDeSenha: '/tmp/senha-ficticia', bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
    lancador, sistema: { async grupoVivo() { linha.push('dump:grupo'); return opc.vivos ?? false; }, async enviarSinal() { return false; } }, arquivos,
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() }, prazos: { ...PRAZOS },
  };
  const declaracaoDoDump = {
    async sha256() {
      linha.push('declaracao');
      if (opc.declaracao === 'ausente') return null;
      if (opc.declaracao === 'divergente') return H('9');
      return sha(DUMP_BYTES);
    },
  };
  const ambiente = { IMAGENS_ARMAZENAMENTO_DIRETORIO: dirOrigem };
  const parametrosDaInicializacao = () => ({
    configuracaoDeImagens: lerConfiguracao(ambiente), diretorioPai: pai, diretorioDoDump: dumps, janela,
    conexao: { criarConexao: () => { linha.push('criarConexao'); return criarCliente(); }, temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }) }, prazos: { finalizacaoMs: 5000 } },
    dump, selagem: criarSelagem(), maxBytesPorArquivo: 4096, declaracaoDoDump,
  });
  const inicializacao = (extras = {}) => criarInicializacaoConfiavel({ ...parametrosDaInicializacao(), ...extras });
  const executar = async (extras = {}) => executarBackupEncadeado({ inicializacao: inicializacao(), nomeDaPreparacao: 'prep-1', conjuntoId: CONJUNTO, ...extras });
  return { raiz, linha, estadoDaTrava, janela, pai, dumps, plano, inicializacao, parametrosDaInicializacao, executar };
}
const antes = (m, a, b) => m.linha.indexOf(a) !== -1 && m.linha.indexOf(b) !== -1 && m.linha.indexOf(a) < m.linha.indexOf(b);
const semVazamento = (valor, m) => {
  const t = JSON.stringify(valor);
  for (const proibido of [SEGREDO, os.tmpdir(), PREFIXO, ...(m ? [m.raiz] : [])]) assert.equal(t.includes(proibido), false, proibido);
};
const semPublicacao = (valor) => { const t = JSON.stringify(valor).toLowerCase(); for (const p of ['publicad', 'restaur']) assert.equal(t.includes(p), false, p); };
async function recusa(promessa, codigo, m, rotulo = '') {
  await assert.rejects(promessa, (e) => {
    assert.equal(e.code, codigo, `${rotulo}: ${e.code}`);
    const texto = `${e.message} ${String(e)}`;
    for (const proibido of [SEGREDO, os.tmpdir(), PREFIXO, m.raiz]) assert.equal(texto.includes(proibido), false, `${rotulo}: ${proibido}`);
    return true;
  }, rotulo);
}

/** Condições DERIVADAS das evidências reais do resultado do encadeamento (nenhum relatório é produzido ou fabricado aqui). */
function condicoesDe(r) {
  const s = r.coordenador.supervisao;
  const t2 = r.correlacao && r.correlacao.dump ? r.correlacao.dump.t2 : null;
  return {
    coordenacao: s === null ? 'AUSENTE' : (r.coordenador.janela === ESTADOS_DA_JANELA.LIBERADA && r.coordenador.finalizacao === ESTADOS_DA_FINALIZACAO.CONCLUIDA ? 'SATISFEITA' : 'NAO_SATISFEITA'),
    procedimento: s === null ? 'AUSENTE' : (s.concluido === true ? 'SATISFEITA' : 'NAO_SATISFEITA'),
    evidenciaFisica: r.evidenciaDoDump === null ? 'AUSENTE' : (r.evidenciaDoDump.ok === true ? 'SATISFEITA' : 'NAO_SATISFEITA'),
    conferenciaT2: t2 === null ? 'AUSENTE' : (t2.ok === true ? 'SATISFEITA' : 'NAO_SATISFEITA'),
    imagensFisicas: r.verificacao === null ? 'AUSENTE' : (r.verificacao.classe === 'INTEGRA' ? 'SATISFEITA' : 'NAO_SATISFEITA'),
    manifesto: r.composicao === null ? 'AUSENTE' : (r.composicao.ok === true && r.composicao.identidade ? 'SATISFEITA' : 'NAO_SATISFEITA'),
    selagem: r.composicao === null ? 'AUSENTE' : (r.composicao.ok === true && r.composicao.selado === true ? 'SATISFEITA' : 'NAO_SATISFEITA'),
    estrutura: 'AUSENTE', // verificação estrutural real inexistente (CONS-03): nunca SATISFEITA
  };
}
const BASE_AVALIADOR = () => ({
  saidaDoProcedimento: 0, manifesto: { arquivos: [] }, listaDoSnapshot: [], verificacao: { concluida: true, ok: true },
  dump: { concluido: true, bytes: 10, sha256Declarado: H('a'), sha256Recalculado: H('a') }, identidade: { conjuntoId: 'x', sha256Manifesto: H('b') },
});

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles reconciliados com os contratos E1–E4', () => {
  teste('CTL-01 — ENCADEAMENTO com avaliação fechada: a composição fica INTEGRA e selada, mas o coordenador classifica NÃO válido (AVALIACAO_NAO_VALIDA); o resultado FINAL do coordenador traz o terminal do supervisor (`coordenador.supervisao`: saída 0, concluído, liberação permitida, código 0, sem sinal), que AGORA também chega à avaliação (`correlacao.supervisao`, E2); o resultado do encadeamento tem as cinco chaves originais mais a chave aditiva `correlacao` e não expõe o plano', async () => {
    const m = await mundo();
    const r = await executarBackupEncadeado({ inicializacao: m.inicializacao(), nomeDaPreparacao: 'prep-1', conjuntoId: CONJUNTO });
    assert.deepEqual(Object.keys(r).sort(), CHAVES_DO_ENCADEAMENTO);
    assert.equal(r.composicao.ok, true);
    assert.equal(r.verificacao.classe, 'INTEGRA');
    assert.equal(r.coordenador.valido, false);
    assert.ok(r.coordenador.motivos.includes('AVALIACAO_NAO_VALIDA'));
    const s = r.coordenador.supervisao;
    assert.deepEqual({ saida: s.saida, concluido: s.concluido, liberarTravaPermitido: s.liberarTravaPermitido, codigoDoProcesso: s.codigoDoProcesso, sinalDoProcesso: s.sinalDoProcesso }, { saida: 0, concluido: true, liberarTravaPermitido: true, codigoDoProcesso: 0, sinalDoProcesso: null });
    const entregue = r.correlacao.supervisao;
    assert.deepEqual({ saida: entregue.saida, concluido: entregue.concluido, liberarTravaPermitido: entregue.liberarTravaPermitido, codigoDoProcesso: entregue.codigoDoProcesso, sinalDoProcesso: entregue.sinalDoProcesso }, { saida: 0, concluido: true, liberarTravaPermitido: true, codigoDoProcesso: 0, sinalDoProcesso: null });
    assert.equal(r.coordenador.janela, ESTADOS_DA_JANELA.LIBERADA);
    assert.equal(r.coordenador.finalizacao, ESTADOS_DA_FINALIZACAO.CONCLUIDA);
    assert.equal(Object.hasOwn(r, 'plano'), false);
  });

  teste('CTL-02 — o veredito terminal do supervisor distingue as falhas no resultado final: saída não zero (saída 9, código 1, liberação permitida), sinal (código nulo, sinal registrado), grupo vivo (saída 11, liberação NEGADA, trava RETIDA) e trava ocupada (sem supervisão); em nenhuma a etapa `copia` roda nem há preparação', async () => {
    const casos = [
      [{ termino: { codigo: 1, sinal: null } }, (s) => assert.deepEqual({ saida: s.saida, concluido: s.concluido, liberar: s.liberarTravaPermitido, codigo: s.codigoDoProcesso }, { saida: 9, concluido: false, liberar: true, codigo: 1 })],
      [{ termino: { codigo: null, sinal: 'SIGKILL' } }, (s) => assert.deepEqual({ concluido: s.concluido, codigo: s.codigoDoProcesso, sinal: s.sinalDoProcesso }, { concluido: false, codigo: null, sinal: 'SIGKILL' })],
      [{ vivos: true }, (s) => assert.deepEqual({ saida: s.saida, concluido: s.concluido, liberar: s.liberarTravaPermitido }, { saida: 11, concluido: false, liberar: false })],
    ];
    for (const [opc, conferir] of casos) {
      const m = await mundo(opc);
      const r = await executarBackupEncadeado({ inicializacao: m.inicializacao(), nomeDaPreparacao: 'prep-1', conjuntoId: CONJUNTO });
      conferir(r.coordenador.supervisao);
      assert.equal(r.composicao, null);
      assert.deepEqual(fs.readdirSync(m.pai), []);
    }
    const ocupada = await mundo({ ocupada: true });
    const r = await executarBackupEncadeado({ inicializacao: ocupada.inicializacao(), nomeDaPreparacao: 'prep-1', conjuntoId: CONJUNTO });
    assert.equal(r.coordenador.saida, SAIDAS.JANELA_OCUPADA);
    assert.equal(r.coordenador.supervisao, null);
  });

  teste('CTL-03 — o avaliador legado é um comparador de campos SEM proveniência: sem `relatorio` o conjunto é inválido (RELATORIO_AUSENTE), e um relatório fabricado { veredito: "VALIDO" } o satisfaz quando NÃO há correlação (resíduo conhecido do comparador puro); no caminho integrado, a mesma entrada com correlação não reconhecida ou com a correlação da cadeia nunca é válida (RELATORIO_SEM_PROVENIENCIA)', () => {
    const base = BASE_AVALIADOR();
    assert.deepEqual([...avaliarConjunto(base).motivos], ['RELATORIO_AUSENTE']);
    assert.equal(avaliarConjunto({ ...base, relatorio: { veredito: 'VALIDO' } }).valido, true);
    assert.equal(avaliarConjunto({ ...base, relatorio: { veredito: 'VALIDO' }, saidaDoProcedimento: 1 }).valido, false);
    const integrado = avaliarConjunto({ ...base, relatorio: { veredito: 'VALIDO' }, correlacao: { snapshot: { operacaoId: 'x' } } });
    assert.equal(integrado.valido, false);
    assert.ok(integrado.motivos.includes('RELATORIO_SEM_PROVENIENCIA'));
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- V-01
describe('[V-01] contrato de confiança satisfeito com FONTES SIMULADAS (não é confiança operacional real)', () => {
  teste('V-01 — fluxo integrado: as condições (coordenação, procedimento, T1, T2, imagens, manifesto, selagem) são SATISFEITAS pelas evidências reais e a correlação é do CONJUNTO; a correlação contratual é satisfeita, MAS o backup não é operacionalmente válido (`valido:false`, `recuperavel:false`, estrutura NÃO executada); o coordenador segue classificando NÃO válido e só ele libera a trava', async () => {
    const m = await mundo();
    const r = await m.executar();
    assert.deepEqual(Object.keys(r).sort(), CHAVES_DO_ENCADEAMENTO);
    assert.equal(Object.isFrozen(r), true);
    assert.equal(r.composicao.ok, true);
    assert.equal(r.coordenador.valido, false, 'o coordenador mantém sua avaliação fechada');
    const condicoes = condicoesDe(r);
    assert.deepEqual(Object.keys(condicoes).sort(), CONDICOES);
    for (const c of CONDICOES.filter((x) => x !== 'estrutura')) assert.equal(condicoes[c], 'SATISFEITA', c);
    assert.equal(condicoes.estrutura, 'AUSENTE', 'a verificação estrutural real não existe (CONS-03): nunca satisfeita');
    // correlação do conjunto, formada pela cadeia
    assert.equal(r.correlacao.escopo, 'CONJUNTO');
    assert.equal(reconhecerCorrelacao(r.correlacao), true);
    assert.match(r.correlacao.snapshot.operacaoId, /^[0-9a-f-]{36}$/);
    assert.equal(r.correlacao.snapshot.snapshotId, ID_SNAPSHOT);
    assert.equal(r.correlacao.manifesto.sha256Manifesto, r.composicao.identidade.sha256Manifesto);
    // avaliação: contratual satisfeita, operacional NÃO
    const av = avaliarConjunto({ ...BASE_AVALIADOR(), relatorio: { veredito: 'VALIDO' }, correlacao: r.correlacao });
    assert.equal(av.correlacaoContratual.satisfeita, true, `motivos: ${[...av.correlacaoContratual.motivos]}`);
    assert.equal(av.valido, false);
    assert.ok(av.motivos.includes('RELATORIO_SEM_PROVENIENCIA'));
    assert.equal(av.recuperavel, false);
    assert.ok(antes(m, 'sql:end', 'janela:liberar'));
    assert.equal(m.estadoDaTrava.liberacoes, 1, 'só o coordenador libera');
    semVazamento(r, m);
    semPublicacao(r);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- V-02
describe('[V-02] falhas do procedimento e da evidência: avaliação FECHADA, correlação do conjunto NÃO formada, diagnósticos preservados', () => {
  const casos = [
    ['saída não zero', { termino: { codigo: 1, sinal: null } }, { procedimento: 'NAO_SATISFEITA' }],
    ['encerrado por sinal', { termino: { codigo: null, sinal: 'SIGKILL' } }, { procedimento: 'NAO_SATISFEITA' }],
    ['grupo do dump ainda vivo (supervisão inconclusiva)', { vivos: true }, { procedimento: 'NAO_SATISFEITA', coordenacao: 'NAO_SATISFEITA' }],
    ['trava ocupada (nada supervisionado)', { ocupada: true }, { procedimento: 'AUSENTE', evidenciaFisica: 'AUSENTE' }],
    ['dump fisicamente vazio', { semBytes: true }, { procedimento: 'SATISFEITA', evidenciaFisica: 'NAO_SATISFEITA' }],
    ['declaração distinta ausente', { declaracao: 'ausente' }, { evidenciaFisica: 'SATISFEITA', manifesto: 'AUSENTE' }],
    ['declaração distinta divergente', { declaracao: 'divergente' }, { evidenciaFisica: 'SATISFEITA', manifesto: 'NAO_SATISFEITA' }],
  ];
  for (const [rotulo, opc, esperado] of casos) {
    teste(`V-02 (${rotulo}) — avaliação fechada, correlação do conjunto não formada, estrutura nunca satisfeita, diagnósticos do encadeamento preservados, nada publicado`, async () => {
      const m = await mundo(opc);
      const r = await m.executar();
      const condicoes = condicoesDe(r);
      for (const [condicao, valor] of Object.entries(esperado)) assert.equal(condicoes[condicao], valor, condicao);
      assert.equal(r.coordenador.valido, false);
      assert.notEqual(r.correlacao?.escopo, 'CONJUNTO', 'sem as evidências obrigatórias a correlação do conjunto nunca é formada');
      assert.equal(condicoes.estrutura === 'SATISFEITA', false);
      assert.deepEqual(Object.keys(r).sort(), CHAVES_DO_ENCADEAMENTO);
      assert.equal(m.estadoDaTrava.liberacoes === 1 || opc.vivos === true || opc.ocupada === true, true);
      if (opc.declaracao === 'ausente') assert.equal(r.aquisicao, null, 'sem declaração, nenhuma preparação é adquirida');
      semVazamento(r, m);
      semPublicacao(r);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- V-03
describe('[V-03] estrutura do dump: o hash/T1/T2 corretos NÃO concluem a validação estrutural, e nenhum verificador arbitrário entra na cadeia', () => {
  const casos = [
    ['estrutura inválida (ok:false)', async (entrada) => ({ ok: false, formato: 'custom', operacaoId: entrada.operacaoId })],
    ['resposta de OUTRA operação', async () => ({ ok: true, formato: 'custom', operacaoId: 'f'.repeat(32) })],
    ['resposta malformada', async () => ({ ok: true })],
    ['resposta nula', async () => null],
    ['verificador que lança', async () => { throw new TypeError(`${SEGREDO} /Users/privado`); }],
  ];
  for (const [rotulo, verificar] of casos) {
    teste(`V-03 (${rotulo}) — um verificador estrutural fornecido pelo chamador é RECUSADO pela inicialização e nunca é consultado; a composição fica íntegra, o hash confere, mas a estrutura segue NÃO executada e nada é válido`, async () => {
      const m = await mundo();
      let consultas = 0;
      const verificadorEstruturalDoDump = { async verificar(entrada) { consultas += 1; return verificar(entrada); } };
      assert.throws(() => m.inicializacao({ verificadorEstruturalDoDump }), (e) => { assert.equal(e.code, 'PARAMETROS_INVALIDOS'); return true; });
      const r = await m.executar();
      assert.equal(consultas, 0, 'a estrutura nunca é delegada ao chamador');
      assert.equal(r.composicao.ok, true);
      assert.equal(r.evidenciaDoDump.ok, true);
      const condicoes = condicoesDe(r);
      assert.equal(condicoes.evidenciaFisica, 'SATISFEITA');
      assert.equal(condicoes.manifesto, 'SATISFEITA');
      assert.equal(condicoes.estrutura, 'AUSENTE');
      const av = avaliarConjunto({ ...BASE_AVALIADOR(), relatorio: { veredito: 'VALIDO' }, correlacao: r.correlacao });
      assert.equal(av.valido, false);
      assert.equal(av.recuperavel, false);
      semVazamento(r, m);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- V-04
describe('[V-04] fronteira de confiança e proibição de avaliador permissivo', () => {
  teste('V-04a — a inicialização do encadeamento só é criada com as dependências aprovadas: avaliador, relatório, veredito, supervisão, coordenador, declaração solta, origem e verificador estrutural entregues, e dependência obrigatória ausente, são PARAMETROS_INVALIDOS, sem tocar disco nem trava', async () => {
    const m = await mundo();
    const antesDeTudo = fs.readdirSync(m.raiz).sort();
    const casos = [
      ['avaliar', { avaliar: async () => ({ valido: true }) }], ['relatorio', { relatorio: { veredito: 'VALIDO' } }], ['veredito', { veredito: 'VALIDO' }], ['supervisao', { supervisao: { concluido: true } }],
      ['coordenador', { coordenador: {} }], ['declaracao', { declaracao: H('a') }], ['origem', { origem: m.raiz }], ['chave desconhecida', { extra: 1 }],
      ['verificador estrutural', { verificadorEstruturalDoDump: { async verificar() { return { ok: true }; } } }],
      ['declaracaoDoDump ausente', { declaracaoDoDump: undefined }], ['janela ausente', { janela: undefined }],
    ];
    for (const [rotulo, extras] of casos) {
      assert.throws(() => criarInicializacaoConfiavel({ ...m.parametrosDaInicializacao(), ...extras }), (e) => { assert.equal(e.code, 'PARAMETROS_INVALIDOS', rotulo); assert.equal(String(e.message).includes(m.raiz), false); return true; }, rotulo);
    }
    assert.deepEqual(fs.readdirSync(m.raiz).sort(), antesDeTudo);
    assert.deepEqual(m.linha, []);
  });

  teste('V-04b — a execução só aceita a inicialização produzida pelo ponto confiável (INICIALIZACAO_INVALIDA para cópia rasa, forjada ou texto) e recusa chaves de chamada proibidas (`relatorio`, `avaliar`, `supervisao`, `veredito`, `operacaoId`, `declaracao`): PARAMETROS_INVALIDOS; nada toca a trava, o snapshot ou o disco', async () => {
    const m = await mundo();
    const inicializacao = m.inicializacao();
    const base = { nomeDaPreparacao: 'prep-1', conjuntoId: CONJUNTO };
    const casos = [
      ['inicialização rasa', { ...base, inicializacao: { ...inicializacao } }, 'INICIALIZACAO_INVALIDA'], ['inicialização texto', { ...base, inicializacao: 'x' }, 'INICIALIZACAO_INVALIDA'], ['inicialização ausente', { ...base }, 'PARAMETROS_INVALIDOS'],
      ['relatorio', { ...base, inicializacao, relatorio: { veredito: 'VALIDO' } }, 'PARAMETROS_INVALIDOS'], ['avaliar', { ...base, inicializacao, avaliar: async () => ({ valido: true }) }, 'PARAMETROS_INVALIDOS'],
      ['supervisao', { ...base, inicializacao, supervisao: { concluido: true } }, 'PARAMETROS_INVALIDOS'], ['veredito', { ...base, inicializacao, veredito: 'VALIDO' }, 'PARAMETROS_INVALIDOS'],
      ['operacaoId', { ...base, inicializacao, operacaoId: 'a'.repeat(32) }, 'PARAMETROS_INVALIDOS'], ['declaracao', { ...base, inicializacao, declaracao: H('a') }, 'PARAMETROS_INVALIDOS'],
      ['nome inválido', { inicializacao, nomeDaPreparacao: '../fora', conjuntoId: CONJUNTO }, 'PARAMETROS_INVALIDOS'],
    ];
    for (const [rotulo, entrada, codigo] of casos) await recusa(executarBackupEncadeado(entrada), codigo, m, rotulo);
    await recusa(executarBackupEncadeado(null), 'PARAMETROS_INVALIDOS', m, 'null');
    assert.deepEqual(m.linha, []);
    assert.deepEqual(fs.readdirSync(m.pai), []);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- V-05
describe('[V-05] autenticidade e vínculo da correlação à operação', () => {
  teste('V-05 — só a correlação PRODUZIDA pela cadeia é reconhecida: cópia rasa, clone JSON e literal com o mesmo conteúdo NÃO são e nunca satisfazem a avaliação; a correlação de uma operação não pertence a outra; mudar o conteúdo é impossível (congelada); um relatório literal `{ veredito: "VALIDO" }` nunca é válido', async () => {
    const a = await mundo();
    const b = await mundo();
    const ra = await a.executar();
    const rb = await b.executar();
    assert.equal(reconhecerCorrelacao(ra.correlacao), true);
    for (const forjado of [{ ...ra.correlacao }, JSON.parse(JSON.stringify(ra.correlacao)), { escopo: 'CONJUNTO', snapshot: { operacaoId: 'x', snapshotId: 'y' } }, { ...ra.correlacao, manifesto: rb.correlacao.manifesto }, null, 'VALIDO', undefined]) {
      assert.equal(reconhecerCorrelacao(forjado), false);
      assert.equal(avaliarCorrelacao(forjado).satisfeita, false);
      // `undefined` equivale a NÃO fornecer correlação: é o resíduo do comparador legado (CTL-03), fora do caminho integrado, que sempre fornece a correlação.
      if (forjado !== undefined) assert.equal(avaliarConjunto({ ...BASE_AVALIADOR(), relatorio: { veredito: 'VALIDO' }, correlacao: forjado }).valido, false);
    }
    assert.notEqual(ra.correlacao.snapshot.operacaoId, rb.correlacao.snapshot.operacaoId);
    assert.equal(ra.correlacao.manifesto.operacaoId, ra.correlacao.snapshot.operacaoId);
    assert.notEqual(ra.correlacao.manifesto.operacaoId, rb.correlacao.snapshot.operacaoId, 'a correlação de uma operação não pertence a outra');
    assert.throws(() => { ra.correlacao.escopo = 'DUMP'; }, TypeError);
    assert.throws(() => { ra.correlacao.manifesto.selado = false; }, TypeError);
    assert.throws(() => { ra.correlacao.dump.t2.ok = false; }, TypeError);
    assert.equal(ra.correlacao.escopo, 'CONJUNTO');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- V-06
describe('[V-06] coordenação, concorrência e isolamento', () => {
  teste('V-06a — duas operações INDEPENDENTES simultâneas (mundos distintos): identificadores, correlações, evidências T1/T2, hashes e preparações próprios; correlações não intercambiáveis; cada trava liberada uma vez, só pelo coordenador', async () => {
    const a = await mundo();
    const b = await mundo();
    const [ra, rb] = await Promise.all([a.executar({ nomeDaPreparacao: 'op-a', conjuntoId: 'conjunto-a' }), b.executar({ nomeDaPreparacao: 'op-b', conjuntoId: 'conjunto-b' })]);
    assert.equal(ra.correlacao.escopo, 'CONJUNTO');
    assert.equal(rb.correlacao.escopo, 'CONJUNTO');
    assert.notEqual(ra.correlacao.snapshot.operacaoId, rb.correlacao.snapshot.operacaoId);
    assert.equal(ra.correlacao.dump.operacaoId, ra.correlacao.snapshot.operacaoId);
    assert.equal(rb.correlacao.dump.operacaoId, rb.correlacao.snapshot.operacaoId);
    assert.equal(ra.correlacao.manifesto.conjuntoId, 'conjunto-a');
    assert.equal(rb.correlacao.manifesto.conjuntoId, 'conjunto-b');
    assert.notEqual(ra.composicao.identidade.sha256Manifesto, rb.composicao.identidade.sha256Manifesto);
    assert.notEqual(ra.correlacao, rb.correlacao);
    assert.equal(a.estadoDaTrava.liberacoes, 1);
    assert.equal(b.estadoDaTrava.liberacoes, 1);
    assert.ok(fs.existsSync(path.join(a.pai, 'op-a', 'manifesto.json')) && !fs.existsSync(path.join(a.pai, 'op-b')));
  });

  teste('V-06b — duas execuções SIMULTÂNEAS contra a MESMA trava: exatamente uma tem procedimento satisfeito e correlação do conjunto; a outra é JANELA_OCUPADA (procedimento AUSENTE), sem correlação e sem preparação; cada uma tem identidade própria quando formada', async () => {
    const m = await mundo();
    const inicializacao = m.inicializacao();
    const [a, b] = await Promise.all([
      executarBackupEncadeado({ inicializacao, nomeDaPreparacao: 'prep-a', conjuntoId: 'conjunto-a' }),
      executarBackupEncadeado({ inicializacao, nomeDaPreparacao: 'prep-b', conjuntoId: 'conjunto-b' }),
    ]);
    const ocupada = [a, b].filter((r) => r.coordenador.saida === SAIDAS.JANELA_OCUPADA);
    const rodou = [a, b].filter((r) => r.coordenador.saida !== SAIDAS.JANELA_OCUPADA);
    assert.equal(ocupada.length, 1);
    assert.equal(rodou.length, 1);
    assert.equal(condicoesDe(ocupada[0]).procedimento, 'AUSENTE');
    assert.equal(ocupada[0].correlacao, null);
    assert.equal(ocupada[0].composicao, null);
    assert.equal(condicoesDe(rodou[0]).procedimento, 'SATISFEITA');
    assert.equal(rodou[0].correlacao.escopo, 'CONJUNTO');
    assert.equal(fs.readdirSync(m.pai).length, 1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- pendências
describe('[PENDÊNCIAS] bloqueios e alterações contratuais necessárias (registrados; nada foi simulado como resolvido)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('C-BLOQUEIO-1 (confiança OPERACIONAL) — INICIALIZAÇÃO OPERACIONAL: componente interno que obtenha a configuração do ambiente real e produza a inicialização; a validade operacional só pode existir quando houver; o marcador do WeakSet prova a origem do objeto no código, não a autorização', 'componente inexistente');
  todo('C-BLOQUEIO-2 (confiança OPERACIONAL) — FONTE REAL e INDEPENDENTE da declaração do hash do dump: a alternativa C (T1/T2) demonstra integridade física ENTRE observações e NÃO a substitui; `declaracaoDoDump` do encadeamento continua simulada e não é contada como independente; exige captura do fluxo ou processo intermediário (decisão futura)', 'fonte e contrato inexistentes');
  todo('C-BLOQUEIO-3 (confiança OPERACIONAL) — VERIFICAÇÃO ESTRUTURAL REAL do dump (`pg_restore --list` sob a mesma supervisão de processo) e vínculo do arquivo verificado ao arquivo observado (mesmo `dev`/`ino`); hoje `estrutura` é sempre NAO_EXECUTADA', 'infraestrutura real ausente');
  teste('C-ALTERACAO-4 (contrato mínimo) — RESOLVIDA por E2: o resultado TERMINAL do supervisor chega à avaliação dentro da janela, vinculado à operação (`correlacao.supervisao`), sem alterar o coordenador; o resultado final continua trazendo `coordenador.supervisao`', async () => {
    const m = await mundo();
    const r = await m.executar();
    assert.equal(r.correlacao.supervisao.operacaoId, r.correlacao.snapshot.operacaoId);
    assert.equal(r.correlacao.supervisao.concluido, true);
    assert.equal(r.correlacao.supervisao.saida, r.coordenador.supervisao.saida);
    assert.ok(Object.isFrozen(r.correlacao.supervisao));
  });
  todo('C-ALTERACAO-5 (contrato mínimo) — o PLANO do snapshot não é exposto pelo encadeamento: a lista do snapshot do avaliador é derivada do manifesto, cuja igualdade com o plano é imposta por `construirManifesto`; expor o plano exigiria alterar o encadeamento e seu teste', 'alteração contratual pendente');
  todo('C-PENDENCIA-6 (Marco C) — publicação atômica e durável do conjunto INCLUINDO o dump, preparações abandonadas, cancelamento e perda de posse durante a composição, TOCTOU, escritores externos e VF09-11', 'marco seguinte');
  todo('C-PENDENCIA-7 (Marco D) — restauração independente e recuperabilidade: `recuperavel` permanece false; nenhum relatório afirma restauração', 'marco seguinte');
  todo('C-PENDENCIA-8 (autoridade) — enquanto a avaliação for anterior à publicação, a conclusão é sobre evidências já coletadas; a janela entre o fim da coleta e qualquer uso do conjunto não é protegida por trava', 'limite do desenho atual');
});
