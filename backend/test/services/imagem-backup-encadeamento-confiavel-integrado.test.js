'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { lerConfiguracao } = require('../../src/config/imagens');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { criarSelagem } = require('../../src/services/imagem-backup-selagem.service');
const { avaliarConjunto, SAIDAS, ESTADOS_DA_JANELA, ESTADOS_DA_FINALIZACAO } = require('../../src/services/imagem-backup.service');
const { executarBackupPgDump } = require('../../src/services/imagem-backup-pgdump.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-INTEGRADO-ENCADEAMENTO-CONFIAVEL-BACKUP-1, MARCO B): ENCADEAMENTO CONFIÁVEL do backup. Só dados FICTÍCIOS em diretórios temporários exclusivos (prefixo
 * `gepi-enc-test-`). TUDO o que é externo é SIMULADO e identificado como tal: PostgreSQL (cliente falso), `pg_dump` (lançador falso que escreve bytes no descritor), trava (janela falsa), inicialização operacional
 * (função da fixture) e a declaração independente do hash do dump ("tap" simulado). Os componentes aprovados são REAIS: configuração de imagens, coordenador, snapshot, `executarBackupPgDump` (supervisor incluso),
 * observador do dump, aquisição exclusiva, montagem, cópia, verificação física, manifesto, composição e selagem. O sucesso aqui comprova ENCADEAMENTO CONTRATUAL SIMULADO: não é validade operacional, publicação nem recuperabilidade.
 *
 * INSPEÇÃO CONTRATUAL (respostas):
 *  1. Quem inicia: hoje NINGUÉM liga as peças; `executarBackupPgDump({ janela, conexao, dump, copia, avaliar, parada? })` (imagem-backup-pgdump.service.js) é a entrada mais alta e recebe `copia` e `avaliar` do chamador.
 *  2. Autoridade sobre a configuração operacional: `lerConfiguracao`/`exigirDiretorio` (config/imagens.js) provam só que a configuração foi PRODUZIDA por `lerConfiguracao`; NÃO existe ponto de inicialização
 *     operacional que a obtenha do ambiente real nem configuração do diretório-pai (lacuna).
 *  3. Snapshot e trava: o coordenador (`executarBackup`) adquire a janela (trava), o operacional abre o snapshot (`criarSnapshot.abrir`), e é DELE a finalização do snapshot e a liberação; ordem real: janela -> snapshot
 *     -> dump supervisionado -> copia -> avaliar -> finalizar -> liberar. A etapa `copia` só roda se o dump foi concluído e a supervisão permite liberar (o coordenador lê `concluido` e `liberarTravaPermitido`).
 *  4. O supervisor de `executarBackupPgDump` conhece o resultado terminal do dump; esse veredito NÃO chega à etapa `copia` nem ao `avaliar` (o `avaliar` só recebe os nomes das etapas). O que chega é o controle de fluxo: `copia`
 *     só roda depois da conclusão supervisionada.
 *  5. Evidência física: produzida por `criarObservadorDoDump` (envolvendo `arquivos` e `lancador` injetados em `dump`), consumida na etapa `copia`; só vale com saída 0 observada e fluxos fechados.
 *  6. Declaração independente do hash do dump: NÃO tem fonte confiável em nenhum contrato (o observador calcula, nada "declara"); o manifesto exige `sha256Declarado === sha256Recalculado`. Copiar o hash calculado para o campo
 *     declarado seria autoverificação. Nesta especificação a declaração vem de uma FONTE DISTINTA, SIMULADA pela fixture (um "tap" que a fixture calcula dos bytes que ela mesma escreveu); a fonte real continua um bloqueio.
 *  7. Aquisição da preparação: depende de nada do snapshot; pelos contratos pode ocorrer quando a etapa `copia` começa (depois do dump concluído e da evidência/declaração), o que evita preparações reservadas quando a trava está
 *     ocupada, o snapshot ou o dump falham.
 *  8. Quem ordena cópia, verificação, manifesto e selagem: a composição (via montagem), já aprovada.
 *  9. Quem encerra os recursos: o coordenador (finaliza o snapshot e libera a trava), inclusive em falha; a nova camada NUNCA o faz.
 * 10. Falta: o componente que reúne tudo, vinculado a uma inicialização confiável.
 *
 * INTERFACE MÍNIMA PROPOSTA (provisória; módulo e nomes NÃO aprovados): src/services/imagem-backup-encadeamento-confiavel-integrado.service.js exporta
 *   `criarInicializacaoConfiavel({ configuracaoDeImagens, diretorioPai, diretorioDoDump, janela, conexao: { criarConexao, temporizador, prazos }, dump: { alvo, lancador, sistema, arquivos, temporizador, prazos }, selagem?, maxBytesPorArquivo,
 *   declaracaoDoDump: { sha256 } })` -> objeto congelado MARCADO (WeakSet interno, no mesmo padrão de `lerConfiguracao`): só o ponto de inicialização confiável o cria. ESTRITO: recusa `avaliar`, `copia`, `processoDoDump`, `snapshot`, `finalizar`,
 *   `planejar`, `origem`, `preparacao`, `destino`, `armazenamento`, chaves desconhecidas, diretórios não absolutos/canônicos/existentes;
 *   `executarBackupEncadeado({ inicializacao, nomeDaPreparacao, conjuntoId, parada? })` (assíncrona) -> congelado { coordenador, composicao, verificacao, aquisicao, evidenciaDoDump } ou rejeita com Error de `code`
 *   PARAMETROS_INVALIDOS | INICIALIZACAO_INVALIDA (objeto não produzido por `criarInicializacaoConfiavel`), sem tocar trava, snapshot ou disco. Internamente: `planejar` = `planejarArquivos`; `avaliar` é PRÓPRIO e FECHA contra sucesso
 *   (não recebe avaliador do chamador); a etapa `copia` do coordenador faz, nesta ordem: (a) evidência do observador, (b) declaração independente, (c) `adquirirPreparacaoExclusiva`, (d) `compor` da montagem com o `dump`
 *   { concluido, bytes, sha256Declarado (da fonte distinta), sha256Recalculado (do observador) }; qualquer falha devolve `{ ok:false }` ao coordenador, que decide snapshot e trava.
 *   `coordenador` = o resultado do `executarBackupPgDump`; `composicao`/`verificacao` = os da montagem (ou null); `aquisicao` = null | { ok:true } | { ok:false, codigo }; `evidenciaDoDump` = null | o do observador.
 *
 * BLOQUEIO DE CONFIANÇA REGISTRADO: o avaliador completo exige `relatorio.veredito === 'VALIDO'`, que NINGUÉM produz (CTL-02). Por isso, até esse produtor ser especificado, o `avaliar` próprio nunca declara VÁLIDO: o fluxo
 * positivo (E-01) conclui a composição e o coordenador encerra snapshot e trava, mas classifica o backup como NÃO válido (AVALIACAO_NAO_VALIDA). A expectativa só muda por decisão explícita quando existir esse produtor.
 *
 * COMO LER: o módulo NÃO existe; falhas por "módulo ausente" NÃO são provas comportamentais independentes. Os CTL-* passam hoje.
 */

const MODULO = 'src/services/imagem-backup-encadeamento-confiavel-integrado.service';
const modulo = () => exigirModulo(MODULO);
const PRAZO = 30000;
const PREFIXO = 'gepi-enc-test-';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const CONJUNTO = 'conjunto-enc-0001';
const ID_SNAPSHOT = '00000003-0000001B-1';
const teste = (nome, fn) => test(nome, { timeout: PRAZO }, fn);
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DUMP_BYTES = Buffer.from('dump-ficticio-0123456789-'.repeat(120));
const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };

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

/** Mundo SIMULADO: origem fictícia semeada em disco (armazenamento real), PostgreSQL falso, `pg_dump` falso, trava falsa e fonte de declaração simulada. */
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
  const conteudos = [pm, pn, em, ee, en];
  for (const item of plano) await origem.gravar(item.chave, conteudos.find((c) => sha(c) === item.sha256), { maxBytes: 4096, sha256Esperado: item.sha256 });
  // REMOÇÃO EXTERNA explícita (o armazenamento recusa remover sem a posse da janela de LIMPEZA): o arquivo some da origem por fora da aplicação.
  if (opc.removerDaOrigem !== undefined) fs.unlinkSync(path.join(dirOrigem, ...plano[opc.removerDaOrigem].chave.split('/')));
  const pai = path.join(raiz, 'preparacoes');
  const dumps = path.join(raiz, 'dumps');
  fs.mkdirSync(pai, { mode: 0o700 });
  fs.mkdirSync(dumps, { mode: 0o700 });

  // --- trava SIMULADA (janela)
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

  // --- PostgreSQL SIMULADO (cliente falso)
  const respostas = opc.respostas ?? {};
  const criarCliente = () => {
    const c = {
      ouvintes: { error: [], end: [] },
      async connect() { linha.push('sql:connect'); },
      async query(sql, parametros) {
        const tipo = tipoDe(sql);
        linha.push(`sql:${tipo}`);
        if (respostas[tipo]) return respostas[tipo](sql, parametros);
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
  const temporizadorDoSnapshot = { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }) };

  // --- pg_dump SIMULADO: o lançador escreve bytes no descritor recebido e devolve promessas já resolvidas; os arquivos são criados de forma exclusiva de verdade
  let caminhoDoDump = null;
  const arquivos = {
    criarExclusivo(spec) {
      caminhoDoDump = path.join(spec.diretorio, spec.nome);
      const descritor = fs.openSync(caminhoDoDump, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, spec.modo);
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
  let adulterou = false;
  const sistema = {
    async grupoVivo() {
      linha.push('dump:grupo');
      if (opc.adulterarDumpAoVerificarGrupo && !adulterou && caminhoDoDump !== null) { adulterou = true; fs.appendFileSync(caminhoDoDump, Buffer.from('bytes-extras')); }
      return opc.vivos ?? false;
    },
    async enviarSinal() { return false; },
  };
  const dump = {
    alvo: { executavel: '/usr/bin/pg_dump', host: '127.0.0.1', porta: 5432, usuario: 'gepi', arquivoDeSenha: '/tmp/senha-ficticia', bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
    lancador, sistema, arquivos, temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() }, prazos: { ...PRAZOS },
  };

  // --- declaração independente SIMULADA ("tap" calculado pela fixture dos bytes que ela própria escreveu: fonte DISTINTA do observador, mas não real)
  const estado = { preparacoesNaDeclaracao: null };
  const declaracaoDoDump = {
    async sha256() {
      linha.push('declaracao');
      estado.preparacoesNaDeclaracao = fs.readdirSync(pai);
      if (opc.declaracao === 'ausente') return null;
      if (opc.declaracao === 'lanca') throw new TypeError(`${SEGREDO} /Users/privado`);
      if (opc.declaracao === 'divergente') return H('9');
      return sha(DUMP_BYTES);
    },
  };

  // --- selagem real com espiões e falhas opcionais
  const selagemReal = criarSelagem();
  const selagem = {
    selar: async (e) => { linha.push('selar'); if (opc.falhaSelar) return { ok: false, selado: false, falha: { codigo: 'ESCRITA_FALHOU' } }; return selagemReal.selar(e); },
    verificar: async (e) => { linha.push('verificar-selagem'); if (opc.falhaVerificarSelagem) return { ok: false, falha: { codigo: 'MANIFESTO_INVALIDO' } }; return selagemReal.verificar(e); },
  };

  const ambiente = { IMAGENS_ARMAZENAMENTO_DIRETORIO: opc.origemConfigurada ?? dirOrigem };
  const parametrosDaInicializacao = () => ({
    configuracaoDeImagens: lerConfiguracao(ambiente), diretorioPai: opc.diretorioPai ?? pai, diretorioDoDump: dumps, janela,
    conexao: { criarConexao: () => { linha.push('criarConexao'); return criarCliente(); }, temporizador: temporizadorDoSnapshot, prazos: { finalizacaoMs: 5000 } },
    dump, selagem, maxBytesPorArquivo: 4096, declaracaoDoDump,
  });
  const inicializacao = (extras = {}) => modulo().criarInicializacaoConfiavel({ ...parametrosDaInicializacao(), ...extras });
  const executar = async (extras = {}, inicExtras = {}) => modulo().executarBackupEncadeado({ inicializacao: await inicializacao(inicExtras), nomeDaPreparacao: 'prep-1', conjuntoId: CONJUNTO, ...extras });
  return { raiz, linha, estadoDaTrava, estado, janela, parametrosDaInicializacao, inicializacao, executar, plano, pai, dumps, dirOrigem, criarCliente, temporizadorDoSnapshot, dump, selagem, getCaminhoDoDump: () => caminhoDoDump };
}
const noLinha = (m, evento) => m.linha.includes(evento);
const antes = (m, a, b) => m.linha.indexOf(a) !== -1 && m.linha.indexOf(b) !== -1 && m.linha.indexOf(a) < m.linha.indexOf(b);
const semVazamento = (valor, m) => {
  const t = JSON.stringify(valor);
  for (const proibido of [SEGREDO, os.tmpdir(), PREFIXO, ...(m ? [m.raiz] : [])]) assert.equal(t.includes(proibido), false, proibido);
};
const semAfirmacoes = (valor) => {
  const t = JSON.stringify(valor).toLowerCase();
  for (const proibida of ['publicad', 'restaur']) assert.equal(t.includes(proibida), false, proibida);
};
const nadaAdquirido = (r, m) => {
  assert.equal(r.aquisicao, null);
  assert.equal(r.composicao, null);
  assert.deepEqual(fs.readdirSync(m.pai), []);
};
async function recusa(promessa, codigo, m, rotulo = '') {
  await assert.rejects(promessa, (e) => {
    assert.equal(e.code, codigo, `${rotulo}: ${e.code}`);
    const texto = `${e.message} ${String(e)}`;
    for (const proibido of [SEGREDO, os.tmpdir(), PREFIXO, m.raiz]) assert.equal(texto.includes(proibido), false, `${rotulo}: ${proibido}`);
    return true;
  }, rotulo);
}

/** Dependências brutas de `executarBackupPgDump` para os controles (sem o módulo futuro). */
function dependenciasBrutas(m, { copia, avaliar }) {
  return {
    janela: m.janela,
    conexao: { criarConexao: () => { m.linha.push('criarConexao'); return m.criarCliente(); }, temporizador: m.temporizadorDoSnapshot, prazos: { finalizacaoMs: 5000 }, planejar: planejarArquivos },
    dump: { ...m.dump, destino: { diretorio: m.dumps, nome: 'dump-controle.custom' } },
    copia, avaliar,
  };
}

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: contratos reais do coordenador, do supervisor e do avaliador', () => {
  teste('CTL-01 — ORDEM REAL do coordenador com os componentes reais (cliente, dump e trava SIMULADOS): janela -> snapshot (BEGIN) -> dump -> copia -> avaliar -> finalização do snapshot (ROLLBACK e end) -> liberação; e um `avaliar` PERMISSIVO injetado faz o coordenador classificar VÁLIDO: o `avaliar` é uma fronteira de confiança, por isso a camada nova NÃO aceita avaliador do chamador', async () => {
    const m = await mundo();
    const r = await executarBackupPgDump(dependenciasBrutas(m, { copia: async () => { m.linha.push('copia'); return { ok: true }; }, avaliar: async () => { m.linha.push('avaliar'); return { valido: true }; } }));
    for (const [a, b] of [['janela:adquirir', 'sql:BEGIN'], ['sql:BEGIN', 'dump:lancado'], ['dump:lancado', 'copia'], ['copia', 'avaliar'], ['avaliar', 'sql:ROLLBACK'], ['sql:ROLLBACK', 'sql:end'], ['sql:end', 'janela:liberar']]) assert.ok(antes(m, a, b), `${a} antes de ${b}: ${m.linha.join(' > ')}`);
    assert.equal(r.valido, true);
    assert.equal(r.saida, SAIDAS.VALIDO);
    assert.equal(r.janela, ESTADOS_DA_JANELA.LIBERADA);
    assert.equal(r.finalizacao, ESTADOS_DA_FINALIZACAO.CONCLUIDA);
    assert.equal(r.recuperavel, false);
  });

  teste('CTL-02 — o avaliador completo exige `relatorio.veredito`, que NINGUÉM produz; um valor fabricado o satisfaz (campo declarativo): sem o relatório o conjunto nunca é válido, e é esse o bloqueio de confiança que o encadeamento precisa respeitar sem inventar parecer positivo', () => {
    const base = {
      saidaDoProcedimento: 0, manifesto: { arquivos: [] }, listaDoSnapshot: [], verificacao: { concluida: true, ok: true }, dump: { concluido: true, bytes: 10, sha256Declarado: H('a'), sha256Recalculado: H('a') }, identidade: { conjuntoId: 'x', sha256Manifesto: H('b') },
    };
    const semRelatorio = avaliarConjunto(base);
    assert.equal(semRelatorio.valido, false);
    assert.deepEqual([...semRelatorio.motivos], ['RELATORIO_AUSENTE']);
    assert.equal(avaliarConjunto({ ...base, relatorio: { veredito: 'VALIDO' } }).valido, true, 'um relatório fabricado satisfaz o avaliador: não há proveniência');
  });

  teste('CTL-03 — AUTORIDADE DO COORDENADOR: com o dump terminando com saída diferente de zero a etapa `copia` NUNCA roda; o snapshot é finalizado e a trava liberada pelo coordenador (a supervisão permite: término e grupo confirmados); com o grupo ainda vivo a trava fica RETIDA, a finalização ADIADA e nada é liberado', async () => {
    const falho = await mundo({ termino: { codigo: 1, sinal: null } });
    let copiou = false;
    const r1 = await executarBackupPgDump(dependenciasBrutas(falho, { copia: async () => { copiou = true; return { ok: true }; }, avaliar: async () => ({ valido: true }) }));
    assert.equal(copiou, false);
    assert.equal(r1.valido, false);
    assert.equal(r1.janela, ESTADOS_DA_JANELA.LIBERADA);
    assert.equal(r1.finalizacao, ESTADOS_DA_FINALIZACAO.CONCLUIDA);
    assert.ok(antes(falho, 'sql:end', 'janela:liberar'));

    const vivo = await mundo({ vivos: true });
    const r2 = await executarBackupPgDump(dependenciasBrutas(vivo, { copia: async () => { copiou = true; return { ok: true }; }, avaliar: async () => ({ valido: true }) }));
    assert.equal(copiou, false);
    assert.equal(r2.janela, ESTADOS_DA_JANELA.RETIDA);
    assert.equal(r2.finalizacao, ESTADOS_DA_FINALIZACAO.ADIADA);
    assert.equal(noLinha(vivo, 'janela:liberar'), false);
    assert.equal(noLinha(vivo, 'sql:ROLLBACK'), false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- E-01
describe('[E-01] fluxo positivo integrado (SIMULADO nas fronteiras): encadeamento contratual, não validade operacional', () => {
  teste('E-01 — da inicialização à selagem: a preparação só é adquirida DEPOIS do dump e da declaração (no instante da declaração ainda não existe nenhuma); evidência física calculada, declaração de fonte distinta, cópia, verificação, manifesto, selagem e releitura da selagem acontecem na ordem; o coordenador encerra snapshot e trava DEPOIS; o backup NÃO é classificado válido (bloqueio do relatório) e nada é publicado', async () => {
    const m = await mundo();
    const r = await m.executar();
    // E4: a chave `correlacao` (null | correlação do dump | correlação do conjunto) é acrescentada de forma ADITIVA; as cinco chaves originais e seus formatos não mudam.
    assert.deepEqual(Object.keys(r).sort(), ['aquisicao', 'composicao', 'coordenador', 'correlacao', 'evidenciaDoDump', 'pacote', 'publicacao', 'verificacao']);
    assert.equal(Object.isFrozen(r), true);
    // ordem
    for (const [a, b] of [['janela:adquirir', 'sql:BEGIN'], ['sql:BEGIN', 'dump:lancado'], ['dump:lancado', 'dump:grupo'], ['dump:grupo', 'declaracao'], ['declaracao', 'selar'], ['selar', 'verificar-selagem'], ['verificar-selagem', 'sql:ROLLBACK'], ['sql:ROLLBACK', 'sql:end'], ['sql:end', 'janela:liberar']]) assert.ok(antes(m, a, b), `${a} antes de ${b}: ${m.linha.join(' > ')}`);
    assert.deepEqual(m.estado.preparacoesNaDeclaracao, [], 'nenhuma preparação reservada antes do dump e da declaração');
    // evidência física do dump (calculada) e fonte distinta da declaração
    assert.deepEqual(Object.keys(r.evidenciaDoDump).sort(), ['bytes', 'ok', 'sha256Calculado']);
    assert.equal(r.evidenciaDoDump.bytes, DUMP_BYTES.length);
    assert.equal(r.evidenciaDoDump.sha256Calculado, sha(DUMP_BYTES));
    // composição, verificação física e layout
    assert.equal(r.aquisicao.ok, true);
    assert.equal(r.composicao.ok, true);
    assert.equal(r.composicao.selado, true);
    assert.equal(r.composicao.arquivos, 5);
    assert.deepEqual({ ...r.composicao.manifesto.dump }, { bytes: DUMP_BYTES.length, sha256: sha(DUMP_BYTES) });
    assert.equal(r.verificacao.classe, 'INTEGRA');
    // Marco C: com a correlação do conjunto satisfeita, o dump é INCORPORADO ao pacote (`dump/postgres.dump`); o dump temporário original continua fora da preparação.
    assert.deepEqual(fs.readdirSync(path.join(m.pai, 'prep-1')).sort(), ['dump', 'imagens', 'manifesto.json', 'manifesto.sha256']);
    assert.deepEqual(fs.readdirSync(path.join(m.pai, 'prep-1', 'dump')), ['postgres.dump']);
    assert.deepEqual(fs.readdirSync(m.dumps), ['dump-prep-1.custom'], 'o dump fica fora da preparação (layout aprovado preservado)');
    // autoridade do coordenador: encerrou com sucesso mecânico, mas NÃO validou
    assert.deepEqual([...r.coordenador.etapasExecutadas], ['snapshot', 'dump', 'copia']);
    assert.equal(r.coordenador.janela, ESTADOS_DA_JANELA.LIBERADA);
    assert.equal(r.coordenador.finalizacao, ESTADOS_DA_FINALIZACAO.CONCLUIDA);
    assert.equal(r.coordenador.valido, false, 'bloqueio: sem produtor do relatório o avaliador próprio fecha contra sucesso');
    assert.ok(r.coordenador.motivos.includes('AVALIACAO_NAO_VALIDA'));
    assert.equal(r.coordenador.recuperavel, false);
    assert.equal(m.estadoDaTrava.liberacoes, 1);
    semVazamento(r, m);
    semAfirmacoes(r);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- E-02
describe('[E-02] fronteira de confiança', () => {
  teste('E-02a — a inicialização só é aceita se produzida pelo ponto confiável: objeto igual mas forjado, ausente, texto, ou chaves de chamada proibidas (`avaliar`, `copia`, `janela`, `dump`, `origem`, `diretorioPai`, `preparacao`, `destino`) são recusados ANTES de qualquer trava, snapshot ou disco', async () => {
    const m = await mundo();
    const valida = await m.inicializacao();
    const forjada = { ...m.parametrosDaInicializacao() };
    const base = { nomeDaPreparacao: 'prep-1', conjuntoId: CONJUNTO };
    const antesDeTudo = fs.readdirSync(m.raiz).sort();
    const casos = [
      ['inicialização forjada', { ...base, inicializacao: forjada }, 'INICIALIZACAO_INVALIDA'], ['inicialização ausente', { ...base }, 'PARAMETROS_INVALIDOS'], ['inicialização é texto', { ...base, inicializacao: 'x' }, 'INICIALIZACAO_INVALIDA'],
      ['cópia rasa da válida', { ...base, inicializacao: { ...valida } }, 'INICIALIZACAO_INVALIDA'],
      ['`avaliar` permissivo', { ...base, inicializacao: valida, avaliar: async () => ({ valido: true }) }, 'PARAMETROS_INVALIDOS'], ['`copia` própria', { ...base, inicializacao: valida, copia: async () => ({ ok: true }) }, 'PARAMETROS_INVALIDOS'],
      ['`janela` própria', { ...base, inicializacao: valida, janela: m.janela }, 'PARAMETROS_INVALIDOS'], ['`dump` próprio', { ...base, inicializacao: valida, dump: m.dump }, 'PARAMETROS_INVALIDOS'],
      ['`origem` própria', { ...base, inicializacao: valida, origem: m.dirOrigem }, 'PARAMETROS_INVALIDOS'], ['`diretorioPai` próprio', { ...base, inicializacao: valida, diretorioPai: m.pai }, 'PARAMETROS_INVALIDOS'],
      ['`preparacao` própria', { ...base, inicializacao: valida, preparacao: m.pai }, 'PARAMETROS_INVALIDOS'], ['`destino` próprio', { ...base, inicializacao: valida, destino: m.pai }, 'PARAMETROS_INVALIDOS'],
      ['nome inválido', { inicializacao: valida, nomeDaPreparacao: '../fora', conjuntoId: CONJUNTO }, 'PARAMETROS_INVALIDOS'], ['conjuntoId não é string', { inicializacao: valida, nomeDaPreparacao: 'prep-1', conjuntoId: 5 }, 'PARAMETROS_INVALIDOS'],
    ];
    for (const [rotulo, entrada, codigo] of casos) await recusa(modulo().executarBackupEncadeado(entrada), codigo, m, rotulo);
    await recusa(modulo().executarBackupEncadeado(null), 'PARAMETROS_INVALIDOS', m, 'null');
    assert.deepEqual(m.linha, [], 'nenhuma trava, snapshot ou dump foi tocado');
    assert.deepEqual(fs.readdirSync(m.raiz).sort(), antesDeTudo);
  });

  teste('E-02b — a criação da inicialização é estrita: avaliador, cópia, processo do dump, snapshot, finalização, planejador, origem, preparação, destino ou armazenamento entregues, e diretórios relativos/inexistentes/arquivo/link, declaração sem `sha256`, são recusados (PARAMETROS_INVALIDOS) sem criar nada', async () => {
    modulo(); // sem o módulo, a falha é "módulo ausente" (e não um código de erro qualquer)
    const m = await mundo();
    const arquivo = path.join(m.raiz, 'arquivo');
    fs.writeFileSync(arquivo, 'x');
    const ligacao = path.join(m.raiz, 'ligacao');
    fs.symlinkSync(m.pai, ligacao);
    const antesDeTudo = fs.readdirSync(m.raiz).sort();
    const ruins = [
      ['avaliar', { avaliar: async () => ({ valido: true }) }], ['copia', { copia: async () => ({ ok: true }) }], ['processoDoDump', { processoDoDump: () => ({}) }], ['snapshot', { snapshot: async () => ({ ok: true }) }],
      ['finalizar', { finalizar: async () => ({ concluida: true }) }], ['planejar', { planejar: () => [] }], ['origem', { origem: m.dirOrigem }], ['preparacao', { preparacao: m.pai }], ['destino', { destino: m.pai }], ['armazenamento', { armazenamento: {} }],
      ['chave desconhecida', { extra: 1 }], ['pai relativo', { diretorioPai: 'relativo' }], ['pai inexistente', { diretorioPai: path.join(m.raiz, 'ausente') }], ['pai é arquivo', { diretorioPai: arquivo }], ['pai é link', { diretorioPai: ligacao }],
      ['dump sem diretório', { diretorioDoDump: path.join(m.raiz, 'ausente') }], ['declaração sem sha256', { declaracaoDoDump: {} }], ['configuração forjada', { configuracaoDeImagens: { diretorio: m.dirOrigem } }], ['limite inválido', { maxBytesPorArquivo: 0 }],
    ];
    for (const [rotulo, extras] of ruins) {
      await assert.rejects(Promise.resolve().then(() => m.inicializacao(extras)), (e) => { assert.equal(e.code, 'PARAMETROS_INVALIDOS', rotulo); assert.equal(String(e.message).includes(m.raiz), false); return true; }, rotulo);
    }
    assert.deepEqual(fs.readdirSync(m.raiz).sort(), antesDeTudo);
    assert.deepEqual(m.linha, []);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- E-03
describe('[E-03] a composição só avança quando os pré-requisitos COORDENADOS estão satisfeitos', () => {
  const casos = [
    ['trava ocupada', { ocupada: true }, (r) => assert.equal(r.coordenador.saida, SAIDAS.JANELA_OCUPADA), (m) => { assert.equal(noLinha(m, 'sql:BEGIN'), false); assert.equal(noLinha(m, 'dump:lancado'), false); }],
    ['snapshot não abre', { respostas: { EXPORTAR: () => { throw new Error(`${SEGREDO} postgres://u:${SEGREDO}@h/db`); } } }, (r) => assert.equal(r.coordenador.valido, false), (m) => assert.equal(noLinha(m, 'dump:lancado'), false)],
    ['dump com saída não zero', { termino: { codigo: 1, sinal: null } }, (r) => { assert.equal(r.coordenador.janela, ESTADOS_DA_JANELA.LIBERADA); assert.equal(r.coordenador.finalizacao, ESTADOS_DA_FINALIZACAO.CONCLUIDA); }, (m) => assert.ok(antes(m, 'sql:end', 'janela:liberar'))],
    ['dump encerrado por sinal', { termino: { codigo: null, sinal: 'SIGKILL' } }, (r) => assert.equal(r.coordenador.valido, false), (m) => assert.equal(noLinha(m, 'declaracao'), false)],
    ['grupo do dump ainda vivo (supervisão inconclusiva)', { vivos: true }, (r) => { assert.equal(r.coordenador.janela, ESTADOS_DA_JANELA.RETIDA); assert.equal(r.coordenador.finalizacao, ESTADOS_DA_FINALIZACAO.ADIADA); }, (m) => { assert.equal(noLinha(m, 'janela:liberar'), false); assert.equal(noLinha(m, 'sql:ROLLBACK'), false); }],
  ];
  for (const [rotulo, opc, aoResultado, aoMundo] of casos) {
    teste(`E-03 (${rotulo}) — nenhuma preparação adquirida, nenhuma composição, nenhuma declaração consumida; snapshot e trava seguem a decisão do COORDENADOR (a nova camada não finaliza nem libera nada)`, async () => {
      const m = await mundo(opc);
      const r = await m.executar();
      nadaAdquirido(r, m);
      assert.equal(r.coordenador.valido, false);
      assert.equal(noLinha(m, 'selar'), false);
      aoResultado(r);
      aoMundo(m);
      semVazamento(r, m);
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- E-04
describe('[E-04] evidência do dump: resultado terminal, evidência física e declaração independente são três coisas', () => {
  teste('E-04a — DECLARAÇÃO DE FONTE DISTINTA DIVERGENTE da evidência física: a composição falha no estágio do manifesto (o hash declarado e o calculado precisam coincidir), sem selagem; a preparação já adquirida PERMANECE reservada (sem limpeza); o coordenador encerra snapshot e trava', async () => {
    const m = await mundo({ declaracao: 'divergente' });
    const r = await m.executar();
    assert.equal(r.aquisicao.ok, true);
    assert.deepEqual({ ...r.composicao.falha }, { estagio: 'MANIFESTO', codigo: 'MANIFESTO_INVALIDO' });
    assert.equal(r.composicao.ok, false);
    assert.equal(noLinha(m, 'selar'), false);
    assert.equal(fs.existsSync(path.join(m.pai, 'prep-1')), true);
    assert.equal(fs.existsSync(path.join(m.pai, 'prep-1', 'manifesto.json')), false);
    assert.equal(r.verificacao.classe, 'INTEGRA', 'as imagens estavam íntegras: a falha é do dump');
    assert.equal(r.coordenador.valido, false);
    assert.ok(antes(m, 'sql:end', 'janela:liberar'));
  });

  teste('E-04b — SEM FONTE DE DECLARAÇÃO (ausente, lança ou valor que não é hash): falha ANTES de adquirir a preparação; nada é copiado; a evidência física NÃO é aceita como declaração de si mesma', async () => {
    for (const declaracao of ['ausente', 'lanca']) {
      const m = await mundo({ declaracao });
      const r = await m.executar();
      nadaAdquirido(r, m);
      assert.equal(r.evidenciaDoDump.ok, true, 'a evidência física existe');
      assert.equal(r.coordenador.valido, false);
      assert.equal(noLinha(m, 'selar'), false);
      semVazamento(r, m);
    }
  });

  teste('E-04c — EVIDÊNCIA FÍSICA INCONCLUSIVA (o arquivo de dump muda depois do término e antes da leitura): a evidência é recusada (ARQUIVO_INSTAVEL), a declaração NÃO é consultada, nada é adquirido nem copiado; dump vazio também é recusado', async () => {
    const instavel = await mundo({ adulterarDumpAoVerificarGrupo: true });
    const r1 = await instavel.executar();
    nadaAdquirido(r1, instavel);
    assert.deepEqual({ ...r1.evidenciaDoDump }, { ok: false, motivo: 'ARQUIVO_INSTAVEL' });
    assert.equal(noLinha(instavel, 'declaracao'), false);
    const vazio = await mundo({ semBytes: true });
    const r2 = await vazio.executar();
    nadaAdquirido(r2, vazio);
    assert.deepEqual({ ...r2.evidenciaDoDump }, { ok: false, motivo: 'ARQUIVO_VAZIO' });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- E-05 / E-06
describe('[E-05 / E-06] preparação e composição', () => {
  teste('E-05a — COLISÃO: preparação existente (mesmo vazia) é recusada (`aquisicao` PREPARACAO_EXISTENTE); o conteúdo existente fica intacto; sem composição; coordenador encerra; origem sobreposta ao pai é ORIGEM_SOBREPOSTA e origem ausente é ORIGEM_INVALIDA', async () => {
    const m = await mundo();
    fs.mkdirSync(path.join(m.pai, 'prep-1'), { mode: 0o700 });
    fs.writeFileSync(path.join(m.pai, 'prep-1', 'residuo.txt'), 'residuo');
    const r = await m.executar();
    assert.deepEqual({ ...r.aquisicao }, { ok: false, codigo: 'PREPARACAO_EXISTENTE' });
    assert.equal(r.composicao, null);
    assert.deepEqual(fs.readdirSync(path.join(m.pai, 'prep-1')), ['residuo.txt']);
    assert.equal(fs.readFileSync(path.join(m.pai, 'prep-1', 'residuo.txt'), 'utf8'), 'residuo');
    assert.ok(antes(m, 'sql:end', 'janela:liberar'));

    const sobreposta = await mundo();
    const r2 = await sobreposta.executar({}, { configuracaoDeImagens: lerConfiguracao({ IMAGENS_ARMAZENAMENTO_DIRETORIO: sobreposta.pai }) });
    assert.deepEqual({ ...r2.aquisicao }, { ok: false, codigo: 'ORIGEM_SOBREPOSTA' });
    assert.deepEqual(fs.readdirSync(sobreposta.pai), []);

    const ausente = await mundo();
    const r3 = await ausente.executar({}, { configuracaoDeImagens: lerConfiguracao({ IMAGENS_ARMAZENAMENTO_DIRETORIO: path.join(ausente.raiz, 'origem-ausente') }) });
    assert.deepEqual({ ...r3.aquisicao }, { ok: false, codigo: 'ORIGEM_INVALIDA' });
    assert.equal(fs.existsSync(path.join(ausente.raiz, 'origem-ausente')), false);
  });

  teste('E-06a — CÓPIA INCOMPLETA (a origem perdeu um arquivo): COPIA/ORIGEM_AUSENTE, verificação NAO_EXECUTADA, sem manifesto e sem selagem, cópia parcial PRESERVADA, a cópia não é repetida; o coordenador encerra snapshot e trava', async () => {
    const m = await mundo({ removerDaOrigem: 4 });
    const r = await m.executar();
    assert.deepEqual({ ...r.composicao.falha }, { estagio: 'COPIA', codigo: 'ORIGEM_AUSENTE' });
    assert.deepEqual({ ...r.verificacao }, { classe: 'NAO_EXECUTADA' });
    assert.equal(noLinha(m, 'selar'), false);
    assert.equal(fs.existsSync(path.join(m.pai, 'prep-1', 'manifesto.json')), false);
    assert.equal(fs.existsSync(path.join(m.pai, 'prep-1', 'imagens', m.plano[0].chave)), true);
    assert.equal(r.coordenador.valido, false);
    assert.ok(antes(m, 'sql:end', 'janela:liberar'));
  });

  teste('E-06b — FALHA NA SELAGEM e FALHA NA RELEITURA DA SELAGEM: SELAGEM/ESCRITA_FALHOU e VERIFICACAO/MANIFESTO_INVALIDO; nunca sucesso, nunca publicação, a preparação fica sem limpeza; o coordenador encerra e NÃO declara validade', async () => {
    const selagem = await mundo({ falhaSelar: true });
    const r1 = await selagem.executar();
    assert.deepEqual({ ...r1.composicao.falha }, { estagio: 'SELAGEM', codigo: 'ESCRITA_FALHOU' });
    assert.equal(noLinha(selagem, 'verificar-selagem'), false);
    const releitura = await mundo({ falhaVerificarSelagem: true });
    const r2 = await releitura.executar();
    assert.deepEqual({ ...r2.composicao.falha }, { estagio: 'VERIFICACAO', codigo: 'MANIFESTO_INVALIDO' });
    for (const [m, r] of [[selagem, r1], [releitura, r2]]) {
      assert.equal(r.composicao.ok, false);
      assert.equal(r.coordenador.valido, false);
      assert.equal(fs.existsSync(path.join(m.pai, 'prep-1', 'imagens')), true);
      assert.ok(antes(m, 'sql:end', 'janela:liberar'));
      semAfirmacoes(r);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- E-07
describe('[E-07] concorrência e isolamento entre operações', () => {
  teste('E-07a — duas execuções SIMULTÂNEAS contra a MESMA trava: exatamente uma roda e a outra é JANELA_OCUPADA, sem snapshot, dump, preparação nem composição; a que rodou segue o fluxo completo', async () => {
    const m = await mundo();
    const inicializacao = await m.inicializacao();
    const [a, b] = await Promise.all([
      modulo().executarBackupEncadeado({ inicializacao, nomeDaPreparacao: 'prep-a', conjuntoId: 'conjunto-a' }),
      modulo().executarBackupEncadeado({ inicializacao, nomeDaPreparacao: 'prep-b', conjuntoId: 'conjunto-b' }),
    ]);
    const ocupadas = [a, b].filter((r) => r.coordenador.saida === SAIDAS.JANELA_OCUPADA);
    const rodou = [a, b].filter((r) => r.coordenador.saida !== SAIDAS.JANELA_OCUPADA);
    assert.equal(ocupadas.length, 1);
    assert.equal(rodou.length, 1);
    assert.equal(ocupadas[0].aquisicao, null);
    assert.equal(ocupadas[0].composicao, null);
    assert.equal(rodou[0].composicao.ok, true);
    assert.equal(fs.readdirSync(m.pai).length, 1, 'só a operação que rodou reservou preparação');
    assert.equal(m.linha.filter((e) => e === 'dump:lancado').length, 1);
  });

  teste('E-07b — operações INDEPENDENTES (mundos e preparações distintos): manifestos próprios, conjuntos diferentes, arquivos e diagnósticos sem mistura, hashes iguais não as tornam a mesma; alterar uma não afeta a outra', async () => {
    const a = await mundo();
    const b = await mundo();
    const [ra, rb] = await Promise.all([a.executar({ nomeDaPreparacao: 'op-a', conjuntoId: 'conjunto-a' }), b.executar({ nomeDaPreparacao: 'op-b', conjuntoId: 'conjunto-b' })]);
    assert.equal(ra.composicao.ok, true);
    assert.equal(rb.composicao.ok, true);
    assert.notEqual(ra.composicao.identidade.sha256Manifesto, rb.composicao.identidade.sha256Manifesto);
    assert.equal(ra.composicao.identidade.conjuntoId, 'conjunto-a');
    assert.equal(rb.composicao.identidade.conjuntoId, 'conjunto-b');
    fs.appendFileSync(path.join(a.pai, 'op-a', 'imagens', a.plano[0].chave), Buffer.from('x'));
    assert.equal(sha(fs.readFileSync(path.join(b.pai, 'op-b', 'imagens', b.plano[0].chave))), b.plano[0].sha256);
    assert.equal(ra.verificacao.classe, 'INTEGRA');
    assert.notEqual(ra.verificacao, rb.verificacao);
    assert.equal(a.estadoDaTrava.liberacoes, 1);
    assert.equal(b.estadoDaTrava.liberacoes, 1);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- E4: correlação do CONJUNTO (manifesto + selagem verificados)
describe('[E4-CONJ] correlação integral: manifesto produzido pelo componente real, selagem executada e RELIDA, digest vindo dessa verificação (diretórios temporários fictícios)', () => {
  const baseDoAvaliador = () => ({
    saidaDoProcedimento: 0, manifesto: { arquivos: [] }, listaDoSnapshot: [], verificacao: { concluida: true, ok: true },
    dump: { concluido: true, bytes: 10, sha256Declarado: H('a'), sha256Recalculado: H('a') }, identidade: { conjuntoId: 'x', sha256Manifesto: H('b') },
  });

  teste('E4-CONJ-01 — caminho positivo: a correlação do encadeamento tem escopo CONJUNTO; o digest do manifesto é o da selagem relida e confere com o arquivo físico `manifesto.sha256` e com o hash do `manifesto.json` em disco; operação, conjunto e preparação são os desta execução; o veredito global continua NÃO válido', async () => {
    const m = await mundo();
    const r = await m.executar();
    assert.ok(r.correlacao, 'a correlação do conjunto deveria existir');
    assert.equal(r.correlacao.escopo, 'CONJUNTO');
    const manifesto = r.correlacao.manifesto;
    const area = path.join(m.pai, 'prep-1');
    const selo = fs.readFileSync(path.join(area, 'manifesto.sha256'), 'utf8').split('  ')[0];
    const bytesDoManifesto = fs.readFileSync(path.join(area, 'manifesto.json'));
    assert.equal(manifesto.sha256Manifesto, r.composicao.identidade.sha256Manifesto, 'o digest vem da verificação da composição, sem hash paralelo');
    assert.equal(manifesto.sha256Manifesto, selo, 'o digest confere com a selagem física');
    assert.equal(manifesto.sha256Manifesto, sha(bytesDoManifesto), 'o digest confere com o manifesto em disco');
    assert.equal(manifesto.conjuntoId, CONJUNTO);
    assert.equal(manifesto.preparacao, 'prep-1');
    assert.equal(manifesto.operacaoId, r.correlacao.snapshot.operacaoId);
    assert.equal(manifesto.selado, true);
    assert.equal(manifesto.verificado, true);
    assert.ok(antes(m, 'selar', 'verificar-selagem'), 'a selagem foi relida (verificada) depois de selada');
    assert.ok(antes(m, 'verificar-selagem', 'sql:ROLLBACK'), 'a releitura ocorreu antes do encerramento do coordenador');
    const av = avaliarConjunto({ ...baseDoAvaliador(), relatorio: { veredito: 'VALIDO' }, correlacao: r.correlacao });
    assert.equal(av.correlacaoContratual.satisfeita, true, `motivos: ${[...av.correlacaoContratual.motivos]}`);
    assert.equal(av.correlacaoContratual.escopo, 'CONJUNTO');
    assert.equal(av.valido, false, 'correlação contratual satisfeita não é backup operacionalmente válido (sem produtor do relatório)');
    assert.equal(av.recuperavel, false);
    assert.equal(r.coordenador.valido, false);
    semVazamento(r.correlacao, m);
  });

  teste('E4-CONJ-02 — manifesto adulterado, selo divergente, digest artificial e releitura que falha: a composição é recusada, a correlação do conjunto NÃO é formada (nunca escopo CONJUNTO) e o coordenador não valida', async () => {
    const cenarios = [
      ['manifesto adulterado depois de selado', (area) => fs.appendFileSync(path.join(area, 'manifesto.json'), ' ')],
      ['selo divergente', (area) => fs.writeFileSync(path.join(area, 'manifesto.sha256'), `${H('e')}  manifesto.json\n`)],
    ];
    for (const [rotulo, adulterar] of cenarios) {
      const m = await mundo();
      const real = criarSelagem();
      const selagem = {
        selar: async (e) => { const resultado = await real.selar(e); adulterar(e.area); return resultado; },
        verificar: async (e) => real.verificar(e),
      };
      const r = await m.executar({}, { selagem });
      assert.notEqual(r.correlacao?.escopo, 'CONJUNTO', rotulo);
      assert.equal(r.composicao?.ok === true, false, rotulo);
      assert.equal(r.coordenador.valido, false, rotulo);
    }
    // digest artificial: a releitura devolve um SHA-256 que não é o do manifesto selado.
    const artificial = await mundo();
    const real = criarSelagem();
    const r1 = await artificial.executar({}, { selagem: { selar: (e) => real.selar(e), verificar: async (e) => { const lido = await real.verificar(e); return lido.ok === true ? { ...lido, sha256: H('d') } : lido; } } });
    assert.notEqual(r1.correlacao?.escopo, 'CONJUNTO', 'digest artificial');
    assert.equal(r1.composicao?.ok === true, false, 'digest artificial');
    // a releitura falha (a verificação existente é obrigatória): sem ela não há correlação do conjunto.
    const m2 = await mundo({ falhaVerificarSelagem: true });
    const r2 = await m2.executar();
    assert.notEqual(r2.correlacao?.escopo, 'CONJUNTO');
    assert.equal(r2.composicao?.ok === true, false);
  });

  teste('E4-CONJ-03 — duas preparações independentes: cada correlação carrega a SUA preparação, o SEU conjunto e a SUA operação; a correlação de uma não é a da outra', async () => {
    const a = await mundo();
    const b = await mundo();
    const ra = await a.executar({ nomeDaPreparacao: 'prep-a' });
    const rb = await b.executar({ nomeDaPreparacao: 'prep-b' });
    assert.equal(ra.correlacao.manifesto.preparacao, 'prep-a');
    assert.equal(rb.correlacao.manifesto.preparacao, 'prep-b');
    assert.notEqual(ra.correlacao.snapshot.operacaoId, rb.correlacao.snapshot.operacaoId);
    assert.notEqual(ra.correlacao, rb.correlacao);
    assert.equal(ra.correlacao.manifesto.sha256Manifesto, sha(fs.readFileSync(path.join(a.pai, 'prep-a', 'manifesto.json'))));
    assert.equal(rb.correlacao.manifesto.sha256Manifesto, sha(fs.readFileSync(path.join(b.pai, 'prep-b', 'manifesto.json'))));
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- pendências
describe('[PENDÊNCIAS] bloqueios e limites, classificados pelo marco que bloqueiam (registrados; nada foi simulado como resolvido)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('B-BLOQUEIO-1 (bloqueia o VEREDITO VÁLIDO) — PRODUTOR do `relatorio.veredito` do avaliador completo: nenhum contrato o produz (o verificador de armazenamento usa outro vocabulário e lê o banco vivo); até lá o encadeamento conclui a composição mas o backup nunca é classificado válido', 'produtor inexistente');
  todo('B-BLOQUEIO-2 (bloqueia a confiança no dump) — FONTE REAL da declaração independente do hash do dump (tap em pipe ao escrever, `pg_restore --list` ou outro procedimento) e verificação estrutural do dump: aqui a fonte é um "tap" simulado pela fixture', 'fonte inexistente');
  todo('B-BLOQUEIO-3 (bloqueia a operação real) — INICIALIZAÇÃO OPERACIONAL: obter `configuracaoDeImagens` do ambiente real, definir a configuração do `diretorioPai` e do `diretorioDoDump` e criar a inicialização marcada; o marcador prova a origem do objeto dentro do código, não a autorização operacional', 'ponto de entrada inexistente');
  todo('B-BLOQUEIO-4 (bloqueia a operação real) — lançador real do `pg_dump`, controle de processo, contenção de descendentes/PGID, `pg_dump` e PostgreSQL reais: tudo simulado aqui', 'infraestrutura real ausente');
  todo('B-PENDENCIA-5 (publicação) — publicação atômica/persistente do conjunto, durabilidade, preparações abandonadas (inventário e política), restauração independente e recuperabilidade', 'marco seguinte');
  todo('B-PENDENCIA-6 (robustez) — pedido de parada e perda/incerteza da posse DURANTE a composição, operação pendente indefinidamente (cancelamento seguro), divergência física e leitura inconclusiva das IMAGENS induzidas pela interface do encadeamento (cobertas no nível do vínculo e da montagem; sem ponto de injeção seguro aqui)', 'sem ponto de injeção');
  todo('B-PENDENCIA-7 (garantia física) — VF09-11 (uma fábrica por montagem, por construção), identidade física contínua, TOCTOU residual, escritores externos e trava que não protege todos os escritores', 'limite da plataforma');
});
