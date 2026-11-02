'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { avaliarConjunto, SAIDAS } = require('../../src/services/imagem-backup.service');
const { executarBackupPgDump } = require('../../src/services/imagem-backup-pgdump.service');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-INTEGRADO-EVOLUCAO-CADEIA-CONFIANCA-1, MARCO B): EVOLUÇÃO dos contratos EXISTENTES para fechar a cadeia de evidências confiáveis.
 * Não é arquitetura nova nem módulo de relatório: cada RED abaixo exercita `executarBackupPgDump`, o supervisor, o coordenador e `avaliarConjunto` REAIS e falha por COMPORTAMENTO ausente (não por módulo ausente).
 * Só dados FICTÍCIOS. Simulados e identificados: PostgreSQL (cliente falso), `pg_dump` (lançador falso que escreve no descritor), trava (janela falsa) e a produção da declaração no caminho de escrita (função da fixture
 * entregue por `arquivos`, a FONTE que o GREEN terá de definir). Nada aqui prova validade operacional, publicação nem recuperabilidade.
 *
 * INSPEÇÃO CONTRATUAL (resumo; matriz completa no relatório):
 *  - `executarBackupPgDump({ janela, conexao, dump, copia, avaliar, parada? })` é ESTRITO (conjunto fechado de chaves); não há campo de identidade da operação.
 *  - Hoje `copia` e `avaliar` são chamados SEM contexto utilizável: `avaliar` recebe só `{ etapas: [nomes] }`; o resultado terminal do supervisor fica numa variável local do executor e só reaparece em `resultado.supervisao`.
 *  - O descritor do dump é entregue direto ao `pg_dump` (`stdio: ['ignore', descritor, 'ignore']`): nenhum ponto do caminho de escrita declara tamanho ou hash; o observador só relê depois.
 *  - `avaliarConjunto` compara campos declarativos sem proveniência: `identidade` do conjunto e `relatorio.veredito` são livres.
 *
 * PROPOSTA MÍNIMA (provisória; nomes NÃO aprovados), todas ADITIVAS e opcionais para quem não usa:
 *  (E1) chave de topo `operacao: { id }` em `executarBackupPgDump` (ou criada internamente antes do snapshot); `copia(contexto)` e `avaliar(contexto)` recebem `{ operacaoId, snapshotId, supervisao, dump }`.
 *  (E2) `contexto.supervisao` = cópia congelada do terminal do supervisor { saida, concluido, liberarTravaPermitido, encerramentoForcado, codigoDoProcesso, sinalDoProcesso }.
 *  (E3) `arquivos.criarExclusivo` pode devolver `declaracao()` -> { bytes, sha256 } produzida NO CAMINHO DE ESCRITA; o serviço a expõe em `contexto.dump.declaracao`, sem copiar o hash do observador.
 *  (E4) `avaliarConjunto` passa a exigir `correlacao`: o mesmo `operacaoId` em snapshot, dump (declaração) e manifesto, cada um com origem produzida; `relatorio.veredito` livre deixa de bastar.
 * A fonte real da declaração (pipe/tee versus outra) NÃO foi verificada contra o `pg_dump` real e continua LACUNA: o RED especifica o contrato observável, não a técnica.
 *
 * COMO LER: os CTL-* passam hoje (caracterizam o estado atual). Os RED-* falham hoje por comportamento. Os TODO são dependências conhecidas fora desta evolução.
 */

const PRAZO = 30000;
const PREFIXO = 'gepi-cadeia-test-';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const ID_SNAPSHOT = '00000003-0000001B-1';
const teste = (nome, fn) => test(nome, { timeout: PRAZO }, fn);
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DUMP_BYTES = Buffer.from('dump-ficticio-0123456789-'.repeat(120));
const PRAZOS = { totalMs: 1000, cortesiaMs: 100, intervaloGrupoMs: 100, tentativasGrupo: 1, consultaGrupoMs: 100 };

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

/** Mundo SIMULADO mínimo: cliente pg falso, janela falsa, `pg_dump` falso. `declaracao` liga a produção SIMULADA no caminho de escrita (E3). */
function mundo(opc = {}) {
  const raiz = novaRaiz();
  const linha = [];
  const dumps = path.join(raiz, 'dumps');
  fs.mkdirSync(dumps, { mode: 0o700 });
  const pm = Buffer.from('padrao-mestre-conteudo');
  const pn = Buffer.from('padrao-miniatura-conteudo');
  const registros = { padrao: [{ id: '1', sha256: sha(pm), sha256Miniatura: sha(pn), sha256Exibicao: null, formato: 'PNG', bytesMestre: pm.length, bytesMiniatura: pn.length, bytesExibicao: null }], empresa: [] };
  const linhasPadrao = [{ id: '1', sha256: sha(pm), sha256_miniatura: sha(pn), sha256_exibicao: null, formato: 'PNG', bytes_mestre: pm.length, bytes_miniatura: pn.length, bytes_exibicao: null }];
  const idSnapshot = opc.idSnapshot ?? ID_SNAPSHOT;

  const estadoDaTrava = { documento: null };
  const janela = {
    async adquirir(argumentos) {
      linha.push('janela:adquirir');
      const token = `token-${linha.length}`;
      estadoDaTrava.documento = { token };
      return Object.freeze({
        tipo: argumentos.tipo,
        async confirmarPosse() { return { confirmada: estadoDaTrava.documento !== null && estadoDaTrava.documento.token === token }; },
        async liberar() { linha.push('janela:liberar'); estadoDaTrava.documento = null; return { liberada: true }; },
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
          case 'EXPORTAR': return { rows: [{ snapshot_id: idSnapshot }] };
          case 'IDENTIDADE': return { rows: [{ nome: 'gestao_epi', oid: '16384' }] };
          case 'PADRAO': return { rows: paginar(linhasPadrao, parametros) };
          case 'EMPRESA': return { rows: [] };
          default: return { rows: [] };
        }
      },
      async end() { linha.push('sql:end'); for (const f of c.ouvintes.end) f(); },
      on(evento, ouvinte) { (c.ouvintes[evento] ??= []).push(ouvinte); return c; },
    };
    return c;
  };
  const temporizador = { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }) };

  let caminhoDoDump = null;
  const bytesEscritos = opc.bytes ?? DUMP_BYTES;
  const arquivos = {
    criarExclusivo(spec) {
      caminhoDoDump = path.join(spec.diretorio, spec.nome);
      const descritor = fs.openSync(caminhoDoDump, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, spec.modo);
      let fechado = false;
      const alca = { descritor, fechar() { if (!fechado) { fechado = true; fs.closeSync(descritor); } } };
      if (opc.declaracao) {
        // SIMULADO: a produção da declaração no caminho de escrita (o que o GREEN terá de definir). Calcula do que o lançador de fato escreveu.
        alca.declaracao = async () => ({ bytes: bytesEscritos.length, sha256: opc.declaracao === 'forjada' ? H('9') : sha(bytesEscritos) });
      }
      return alca;
    },
  };
  const lancador = {
    lancar(spec) {
      linha.push('dump:lancado');
      fs.writeSync(spec.opcoes.stdio[1], bytesEscritos);
      if (opc.adulterarDepois) fs.appendFileSync(caminhoDoDump, Buffer.from('bytes-extras'));
      return { pid: 4242, saida: Promise.resolve(opc.termino ?? { codigo: 0, sinal: null }), fluxosFechados: Promise.resolve(), stdioRecebido: spec.opcoes.stdio };
    },
  };
  const dump = {
    alvo: { executavel: '/usr/bin/pg_dump', host: '127.0.0.1', porta: 5432, usuario: 'gepi', arquivoDeSenha: '/tmp/senha-ficticia', bancoEsperado: { nome: 'gestao_epi', oid: '16384' } },
    lancador,
    sistema: { async grupoVivo() { return false; }, async enviarSinal() { return false; } },
    arquivos,
    temporizador: { prazo: () => ({ promessa: new Promise(() => {}), cancelar() {} }), intervalo: () => Promise.resolve() },
    prazos: { ...PRAZOS },
    destino: { diretorio: dumps, nome: opc.nomeDoDump ?? 'dump-1.custom' },
  };
  const dependencias = (extras = {}) => ({
    janela,
    conexao: { criarConexao: () => { linha.push('criarConexao'); return criarCliente(); }, temporizador, prazos: { finalizacaoMs: 5000 }, planejar: planejarArquivos },
    dump,
    copia: async () => ({ ok: true }),
    avaliar: async () => ({ valido: false }),
    ...extras,
  });
  return { raiz, linha, registros, dump, dependencias, getCaminhoDoDump: () => caminhoDoDump, estadoDaTrava };
}
const antes = (m, a, b) => m.linha.indexOf(a) !== -1 && m.linha.indexOf(b) !== -1 && m.linha.indexOf(a) < m.linha.indexOf(b);
const semVazamento = (valor, m) => {
  const t = JSON.stringify(valor) ?? '';
  for (const proibido of [SEGREDO, os.tmpdir(), PREFIXO, m.raiz]) assert.equal(t.includes(proibido), false, proibido);
};
const semAfirmacoes = (valor) => {
  const t = (JSON.stringify(valor) ?? '').toLowerCase();
  for (const proibida of ['publicad', 'restaur']) assert.equal(t.includes(proibida), false, proibida);
};

/** Executa capturando os argumentos reais recebidos por `copia` e `avaliar`. */
async function executarCapturando(m, { operacao, extras = {} } = {}) {
  const visto = { copia: [], avaliar: [] };
  const r = await executarBackupPgDump(m.dependencias({
    ...(operacao ? { operacao } : {}),
    copia: async (...a) => { visto.copia.push(a); return { ok: true }; },
    avaliar: async (...a) => { visto.avaliar.push(a); return { valido: false }; },
    ...extras,
  }));
  return { r, visto };
}

/**
 * Executa SEM `operacao` (exercita só E2, T1 e T2, sem depender de E1) e, DENTRO de `avaliar`, aplica `mutar(caminho)` ao artefato do dump (se houver) e chama `contexto.dump.conferir()` (T2).
 * Nada contorna a produção: o contexto vem exatamente do que a cadeia entrega; se `dump.conferir` não existir, `t2` fica null e o teste falha pelo contrato ausente.
 */
async function executarComT2(m, mutar, operacao) {
  const capturado = { ctx: null, t2: null };
  const { r, visto } = await executarCapturando(m, {
    ...(operacao ? { operacao } : {}),
    extras: {
      avaliar: async (ctx) => {
        capturado.ctx = ctx;
        if (mutar) mutar(m.getCaminhoDoDump());
        if (typeof ctx?.dump?.conferir === 'function') capturado.t2 = await ctx.dump.conferir();
        return { valido: false };
      },
    },
  });
  return { r, visto, ...capturado };
}
const MOTIVOS_T2 = ['AUSENTE', 'SUBSTITUIDO', 'DIVERGENTE', 'INSTAVEL'];

/**
 * E4 pela CADEIA (RED-05a/05b): com `operacao`, e dentro de `avaliar`, aplica `mutar(caminho)` (opcional), chama T2 (`dump.conferir()`) e só então LÊ `contexto.correlacao`, a correlação que a própria cadeia
 * coordenada forma e entrega (contrato provisório: `{ snapshot:{operacaoId,snapshotId}, dump:{operacaoId,identidade,bytes,sha256,t2}, manifesto:{...} }`; nenhuma fábrica pública, nenhum literal do teste).
 * O veredito do avaliador REAL é calculado sobre essa correlação entregue (`relatorio.veredito` continua exigido pelo avaliador atual, que ainda não tem produtor: limitação registrada).
 * LIMITE do fixture deste arquivo: a cadeia aqui não compõe manifesto nem selagem (isso pertence ao encadeamento, fora deste arquivo), então `correlacao.manifesto` não pode ser exercitado nem exigido aqui.
 */
async function executarCorrelacionado(m, mutar) {
  const colhido = { ctx: null, t2: null, correlacao: null, avaliacao: null };
  const { r } = await executarCapturando(m, {
    operacao: { id: 'op-E4' },
    extras: {
      // A mutação física ocorre ENTRE T1 (obtida antes da cópia) e T2 (executada pelo executor antes da avaliação): é a janela de composição.
      copia: async () => { if (mutar) mutar(m.getCaminhoDoDump()); return { ok: true }; },
      avaliar: async (ctx) => {
        colhido.ctx = ctx;
        colhido.t2 = ctx?.dump?.t2 ?? null; // T2 executada pelo executor ANTES de formar a correlação
        colhido.correlacao = ctx?.correlacao ?? null;
        if (colhido.correlacao !== null) colhido.avaliacao = avaliarConjunto({ ...BASE_AVALIACAO(), relatorio: { veredito: 'VALIDO' }, correlacao: colhido.correlacao });
        return { valido: false };
      },
    },
  });
  return { r, ...colhido };
}
/** Primeiro elo ausente da cadeia (E1 -> E2 -> E3' -> E4), para a falha apontar a dependência verdadeira em vez de parecer prova de E4. */
function exigirCadeiaAteE4(c) {
  assert.ok(c.ctx, 'avaliação não alcançada: depende de E1 (`operacao` ainda recusada pela entrada estrita)');
  assert.equal(c.ctx.operacaoId, 'op-E4', 'depende de E1: identidade da operação ausente no contexto');
  assert.equal(c.ctx.supervisao?.concluido, true, 'depende de E2: supervisão terminal ausente no contexto');
  assert.equal(typeof c.ctx.dump?.observacao, 'object', 'depende de E3\': T1 ausente');
  assert.equal(typeof c.t2, 'object', 'depende de E3\': T2 (`dump.conferir()`) ausente');
  assert.notEqual(c.t2, null, 'depende de E3\': T2 ausente');
  assert.equal(typeof c.correlacao, 'object', 'E4 AUSENTE: a cadeia não entrega `contexto.correlacao` (único elo que falta, E1–E3\' presentes)');
  assert.notEqual(c.correlacao, null, 'E4 AUSENTE: a cadeia não entrega `contexto.correlacao`');
}

const BASE_AVALIACAO = () => ({
  saidaDoProcedimento: 0, manifesto: { arquivos: [] }, listaDoSnapshot: [], verificacao: { concluida: true, ok: true },
  dump: { concluido: true, bytes: 10, sha256Declarado: H('a'), sha256Recalculado: H('a') },
  identidade: { conjuntoId: 'conj-1', sha256Manifesto: H('b') },
});

// ------------------------------------------------------------------------------------------------------------------------------- controles (passam hoje)
describe('[CTL] estado atual caracterizado: o que a cadeia hoje entrega e o que não entrega', () => {
  teste('CTL-01 — ordem real janela -> snapshot -> dump -> copia -> avaliar -> finalização -> liberação (componentes reais, externos simulados)', async () => {
    const m = mundo();
    const { r } = await executarCapturando(m);
    for (const [a, b] of [['janela:adquirir', 'sql:BEGIN'], ['sql:BEGIN', 'dump:lancado'], ['dump:lancado', 'sql:ROLLBACK'], ['sql:ROLLBACK', 'janela:liberar']]) assert.ok(antes(m, a, b), `${a} < ${b}`);
    assert.equal(r.recuperavel, false);
    semVazamento(r, m);
    semAfirmacoes(r);
  });

  teste('CTL-02 — `avaliar` recebe o contexto `etapas` PRESERVADO (nomes das etapas executadas) mais o contexto adicional reconhecido da operação (identidade, snapshot, supervisão, dump, estrutura e correlação)', async () => {
    const m = mundo();
    const { visto } = await executarCapturando(m);
    assert.equal(visto.avaliar.length, 1);
    const entrada = visto.avaliar[0][0];
    assert.deepEqual([...entrada.etapas], ['snapshot', 'dump', 'copia']);
    assert.deepEqual(Object.keys(entrada).sort(), ['correlacao', 'dump', 'estrutura', 'etapas', 'operacaoId', 'snapshotId', 'supervisao']);
  });

  teste('CTL-03 — CARACTERIZAÇÃO: o terminal do supervisor existe, mas só no resultado final (`supervisao`), depois do `avaliar`; durante a avaliação ele não está disponível', async () => {
    const m = mundo();
    const { r } = await executarCapturando(m);
    assert.equal(typeof r.supervisao, 'object');
    assert.equal(r.supervisao.concluido, true);
    assert.equal(r.supervisao.saida, 0);
  });

  teste('CTL-04 — CARACTERIZAÇÃO: o descritor do dump vai direto ao processo (`stdio` fixo [ignore, descritor, ignore]); nenhum ponto do caminho de escrita enxerga os bytes', async () => {
    const m = mundo();
    let stdio = null;
    const original = m.dump.lancador.lancar;
    m.dump.lancador.lancar = (spec) => { stdio = spec.opcoes.stdio; return original(spec); };
    await executarCapturando(m);
    assert.equal(stdio[0], 'ignore');
    assert.equal(typeof stdio[1], 'number');
    assert.equal(stdio[2], 'ignore');
  });

  teste('CTL-05 — a entrada é ESTRITA: chave desconhecida (inclusive uma `operacao` hoje) é recusada sem tocar trava nem snapshot', async () => {
    const m = mundo();
    const r = await executarBackupPgDump({ ...m.dependencias(), intrusa: 1 });
    assert.equal(r.valido, false);
    assert.equal(m.linha.includes('janela:adquirir'), false);
  });

  teste('CTL-06 — o avaliador é declarativo: `identidade` e `relatorio.veredito` fabricados bastam, e NENHUM campo prova a mesma operação (é o buraco que RED-05 fecha)', () => {
    assert.equal(avaliarConjunto({ ...BASE_AVALIACAO(), relatorio: { veredito: 'VALIDO' } }).valido, true);
    assert.deepEqual([...avaliarConjunto(BASE_AVALIACAO()).motivos], ['RELATORIO_AUSENTE']);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- RED comportamental
describe('[RED-01] identidade da operação criada ANTES do snapshot e transportada até a avaliação', () => {
  teste('RED-01a — `executarBackupPgDump` ACEITA `operacao: { id }` (E1) e a trava é adquirida normalmente', async () => {
    const m = mundo();
    const { r } = await executarCapturando(m, { operacao: { id: 'op-0001' } });
    assert.ok(m.linha.includes('janela:adquirir'), 'chave `operacao` foi recusada pela entrada estrita');
    assert.equal(r.saida === undefined, false);
  });

  teste('RED-01b — `copia(contexto)` recebe `operacaoId` igual ao informado e o `snapshotId` REAL do snapshot aberto (correlação por valor produzido, não por texto livre)', async () => {
    const m = mundo();
    const { visto } = await executarCapturando(m, { operacao: { id: 'op-0001' } });
    assert.equal(visto.copia.length, 1);
    const [contexto] = visto.copia[0];
    assert.equal(contexto?.operacaoId, 'op-0001');
    assert.equal(contexto?.snapshotId, ID_SNAPSHOT);
  });

  teste('RED-01c — `avaliar(contexto)` recebe a MESMA operação e o MESMO snapshot que a cópia viu', async () => {
    const m = mundo();
    const { visto } = await executarCapturando(m, { operacao: { id: 'op-0002' } });
    const [ctxCopia] = visto.copia[0] ?? [];
    const [ctxAvaliar] = visto.avaliar[0] ?? [];
    assert.equal(ctxAvaliar?.operacaoId, 'op-0002');
    assert.equal(ctxAvaliar?.snapshotId, ctxCopia?.snapshotId);
    assert.ok(ctxAvaliar?.snapshotId);
  });

  teste('RED-01d — a identidade é criada ANTES do snapshot: operação sem `id` recebe um id GERADO pelo serviço, único por execução (duas execuções, ids diferentes), nunca derivado do chamador de forma previsível', async () => {
    const a = await executarCapturando(mundo());
    const b = await executarCapturando(mundo());
    const ia = a.visto.avaliar[0]?.[0]?.operacaoId;
    const ib = b.visto.avaliar[0]?.[0]?.operacaoId;
    assert.equal(typeof ia, 'string');
    assert.equal(typeof ib, 'string');
    assert.notEqual(ia, ib);
  });

  teste('RED-01e — CONTRAPROVA de isolamento: duas operações CONCORRENTES com ids diferentes veem cada uma o SEU id em `copia` e em `avaliar` (nenhum cruzamento)', async () => {
    const m1 = mundo({ nomeDoDump: 'dump-a.custom' });
    const m2 = mundo({ nomeDoDump: 'dump-b.custom' });
    const [a, b] = await Promise.all([executarCapturando(m1, { operacao: { id: 'op-A' } }), executarCapturando(m2, { operacao: { id: 'op-B' } })]);
    assert.equal(a.visto.copia[0]?.[0]?.operacaoId, 'op-A');
    assert.equal(a.visto.avaliar[0]?.[0]?.operacaoId, 'op-A');
    assert.equal(b.visto.copia[0]?.[0]?.operacaoId, 'op-B');
    assert.equal(b.visto.avaliar[0]?.[0]?.operacaoId, 'op-B');
  });

  teste('RED-01f — o `id` da operação é validado (string não vazia, tamanho limitado, sem controle): inválido é recusado ANTES da trava, sem eco do valor', async () => {
    // (1) Controle de aceitação: uma identidade VÁLIDA precisa ser aceita (trava adquirida e contexto entregue). Sem isto, a rejeição de `operacao` como chave desconhecida não pode passar por validação de id.
    const valida = mundo();
    const { visto: vistoValido } = await executarCapturando(valida, { operacao: { id: 'op-valida-01' } });
    assert.ok(valida.linha.includes('janela:adquirir'), 'identidade válida foi recusada (chave `operacao` ainda desconhecida pela entrada estrita)');
    assert.equal(vistoValido.copia[0]?.[0]?.operacaoId, 'op-valida-01');
    // (2) Só então: identidades inválidas são recusadas ANTES da trava, sem eco do valor, pelo MOTIVO do id (a mesma chamada com id válido foi aceita acima).
    for (const ruim of ['', 'x'.repeat(300), 'a\nb', 42, null]) {
      const m = mundo();
      const r = await executarBackupPgDump(m.dependencias({ operacao: { id: ruim } }));
      assert.equal(r.valido, false, String(ruim));
      assert.equal(m.linha.includes('janela:adquirir'), false, `trava tocada com ${String(ruim).slice(0, 10)}`);
      semVazamento(r, m);
    }
  });
});

describe('[RED-02] resultado terminal do supervisor disponível à avaliação', () => {
  teste('RED-02a — `avaliar(contexto)` recebe `supervisao` com { saida, concluido, liberarTravaPermitido, encerramentoForcado, codigoDoProcesso, sinalDoProcesso } do dump que acabou de terminar', async () => {
    const m = mundo();
    const { visto } = await executarCapturando(m);
    const s = visto.avaliar[0]?.[0]?.supervisao;
    assert.ok(s, '`supervisao` ausente no contexto da avaliação');
    assert.equal(s.saida, 0);
    assert.equal(s.concluido, true);
    assert.equal(s.liberarTravaPermitido, true);
    assert.equal(s.encerramentoForcado, false);
    assert.equal(s.codigoDoProcesso, 0);
    assert.equal(s.sinalDoProcesso, null);
  });

  teste('RED-02b — a `supervisao` do contexto é CONGELADA e é CÓPIA: mutar não altera o resultado final do supervisor', async () => {
    const m = mundo();
    let congelada = null;
    const { r } = await executarCapturando(m, { extras: { avaliar: async (c) => { congelada = c?.supervisao; if (congelada) { try { congelada.saida = 99; } catch { /* congelada */ } } return { valido: false }; } } });
    assert.ok(congelada && Object.isFrozen(congelada));
    assert.equal(r.supervisao.saida, 0);
  });

  teste('RED-02c — CONTRAPROVA: com o dump terminando com código diferente de zero a `copia` não roda e a avaliação NÃO é chamada como se houvesse dump concluído', async () => {
    const m = mundo({ termino: { codigo: 1, sinal: null } });
    const { visto } = await executarCapturando(m);
    assert.equal(visto.copia.length, 0);
    // Se a avaliação for alcançada após a falha, o contexto TEM de trazer a supervisão e ela não pode estar concluída; interrupção antecipada (sem avaliação) também é legítima.
    if (visto.avaliar.length > 0) {
      const ctx = visto.avaliar[0][0];
      assert.equal(typeof ctx?.supervisao, 'object', '`supervisao` ausente numa avaliação alcançada');
      assert.equal(ctx.supervisao.concluido, false);
      assert.equal(ctx.supervisao.saida, SAIDAS.FALHA ?? 9);
    }
    // Contraprova da disponibilidade: numa execução bem-sucedida a avaliação É alcançada e a supervisão presente confirma a conclusão (ausência não satisfaz).
    // Sem `operacao` de propósito: a disponibilidade da supervisão é E2 e não pode depender de E1 (a avaliação já é alcançada hoje).
    const ok = await executarCapturando(mundo());
    assert.equal(ok.visto.avaliar.length, 1, 'a avaliação deveria ser alcançada');
    assert.equal(typeof ok.visto.avaliar[0][0]?.supervisao, 'object', '`supervisao` indefinida numa etapa executada');
    assert.equal(ok.visto.avaliar[0][0].supervisao.concluido, true);
  });

  teste('RED-02d — a `supervisao` entregue ao contexto não contém caminho, comando, credencial nem texto livre do processo', async () => {
    const m = mundo();
    const { visto } = await executarCapturando(m);
    const s = visto.avaliar[0]?.[0]?.supervisao;
    assert.ok(s);
    semVazamento(s, m);
    assert.equal(JSON.stringify(s).includes('pg_dump'), false);
  });
});

/**
 * ALTERNATIVA C (aprovada): integridade física ENTRE OBSERVAÇÕES, nos limites da identidade e da estabilidade verificadas — T1 (observação física após a conclusão supervisionada) e T2 (releitura física
 * antes da futura publicação, `contexto.dump.conferir()`). T1 e T2 NÃO são uma declaração independente originada no caminho de escrita: essa garantia (declaração durante a escrita) NÃO é obtida pela alternativa C
 * e permanece registrada como pendente (exigiria captura do fluxo ou processo intermediário, decisão futura). Validade estrutural real, procedência operacional, publicação e restauração continuam pendentes.
 * Contrato provisório proposto: `dump.observacao` = { origem:'OBSERVACAO_FISICA', bytes, sha256, identidade:{ dev, ino } }; `dump.conferir()` -> congelado { ok, motivo?, bytes?, sha256?, identidade? } com motivos fixos.
 */
describe('[RED-03] integridade física do dump entre observações T1 e T2 (alternativa C)', () => {
  teste('RED-03a — T1: após a conclusão supervisionada o contexto traz `dump.observacao` com tamanho, SHA-256 e identidade (dev/ino) do artefato REALMENTE escrito', async () => {
    const m = mundo();
    const { ctx } = await executarComT2(m);
    const t1 = ctx?.dump?.observacao;
    assert.ok(t1, '`dump.observacao` (T1) ausente no contexto da avaliação');
    assert.equal(t1.bytes, DUMP_BYTES.length);
    assert.equal(t1.sha256, sha(DUMP_BYTES));
    const estado = fs.statSync(m.getCaminhoDoDump());
    assert.equal(t1.identidade?.dev, estado.dev);
    assert.equal(t1.identidade?.ino, estado.ino);
    assert.equal(ctx.supervisao?.concluido, true, 'T1 só vale depois da conclusão supervisionada');
  });

  teste('RED-03b — T1 é OBSERVAÇÃO FÍSICA, não declaração: `origem: "OBSERVACAO_FISICA"` e nenhum campo que a apresente como declaração independente (`declaracao`, `sha256Declarado`, `coincide`)', async () => {
    const m = mundo();
    const { ctx } = await executarComT2(m);
    const dump = ctx?.dump;
    assert.equal(dump?.observacao?.origem, 'OBSERVACAO_FISICA');
    for (const proibido of ['declaracao', 'sha256Declarado', 'coincide']) {
      assert.equal(proibido in dump, false, `\`${proibido}\` não pode existir no contexto da alternativa C`);
      assert.equal(proibido in dump.observacao, false, `\`${proibido}\` não pode existir em T1`);
    }
  });

  teste('RED-03c — T2: a releitura física do artefato íntegro e estável confirma identidade, tamanho e SHA-256 de T1', async () => {
    const m = mundo();
    const { ctx, t2 } = await executarComT2(m);
    assert.ok(t2, '`dump.conferir()` (T2) ausente no contexto da avaliação');
    assert.equal(t2.ok, true);
    assert.equal(t2.bytes, ctx.dump.observacao.bytes);
    assert.equal(t2.sha256, ctx.dump.observacao.sha256);
    assert.deepEqual(t2.identidade, ctx.dump.observacao.identidade);
    assert.ok(Object.isFrozen(t2));
  });

  teste('RED-03d — CONTRAPROVA: conteúdo alterado DEPOIS de T1 (mesma identidade, outro tamanho/SHA-256) é DIVERGENTE em T2', async () => {
    const m = mundo();
    const { t2 } = await executarComT2(m, (caminho) => fs.appendFileSync(caminho, Buffer.from('bytes-extras')));
    assert.ok(t2, '`dump.conferir()` (T2) ausente');
    assert.equal(t2.ok, false);
    assert.equal(t2.motivo, 'DIVERGENTE');
  });

  teste('RED-03e — CONTRAPROVAS: artefato SUBSTITUÍDO (mesmo conteúdo, outro inode) e artefato AUSENTE são recusados em T2 com motivos fixos distintos', async () => {
    const substituido = await executarComT2(mundo(), (caminho) => {
      const temporario = `${caminho}.substituto`;
      fs.writeFileSync(temporario, DUMP_BYTES, { mode: 0o600 });
      fs.renameSync(temporario, caminho);
    });
    assert.ok(substituido.t2, '`dump.conferir()` (T2) ausente');
    assert.equal(substituido.t2.ok, false);
    assert.equal(substituido.t2.motivo, 'SUBSTITUIDO');

    const ausente = await executarComT2(mundo(), (caminho) => fs.unlinkSync(caminho));
    assert.ok(ausente.t2, '`dump.conferir()` (T2) ausente');
    assert.equal(ausente.t2.ok, false);
    assert.equal(ausente.t2.motivo, 'AUSENTE');
  });

  teste('RED-03f — FALHA FECHADA: arquivo instável/truncado em T2 devolve resultado congelado, com motivo de conjunto fixo e sem caminho; e uma falha do dump nunca entrega observação ok', async () => {
    const m = mundo();
    const { t2 } = await executarComT2(m, (caminho) => fs.truncateSync(caminho, 0));
    assert.ok(t2, '`dump.conferir()` (T2) ausente');
    assert.equal(t2.ok, false);
    assert.ok(MOTIVOS_T2.includes(t2.motivo), `motivo fora do conjunto fixo: ${t2.motivo}`);
    assert.ok(Object.isFrozen(t2));
    semVazamento(t2, m);
    // Falha do dump: a cópia não roda e, se a avaliação for alcançada, não há T1 válido.
    const falho = await executarComT2(mundo({ termino: { codigo: 1, sinal: null } }));
    assert.notEqual(falho.ctx?.dump?.observacao?.sha256, sha(DUMP_BYTES), 'T1 não pode ser entregue como válido após falha do dump');
    assert.notEqual(falho.t2?.ok, true);
  });

  teste('RED-03g — a produção da declaração não altera o fluxo de escrita: o lançador continua recebendo o descritor direto (compatibilidade com o `pg_dump` real, sem pipe imposto)', async () => {
    const m = mundo({ declaracao: 'correta' });
    let stdio = null;
    const original = m.dump.lancador.lancar;
    m.dump.lancador.lancar = (spec) => { stdio = spec.opcoes.stdio; return original(spec); };
    await executarCapturando(m);
    assert.deepEqual([stdio?.[0], typeof stdio?.[1], stdio?.[2]], ['ignore', 'number', 'ignore']);
  });
});

describe('[RED-04] verificação estrutural do dump: garantia DISTINTA da observação T1 e da conferência T2, ainda não operacional (CONS-03); função arbitrária não vale', () => {
  teste('RED-04a — o contexto da avaliação traz `estrutura` com { concluida:false, origem:"NAO_EXECUTADA" } enquanto nenhuma verificação real existir (nunca ok:true por omissão)', async () => {
    const m = mundo({ declaracao: 'correta' });
    const { visto } = await executarCapturando(m);
    const e = visto.avaliar[0]?.[0]?.estrutura;
    assert.ok(e, '`estrutura` ausente');
    assert.equal(e.concluida, false);
    assert.notEqual(e.ok, true);
  });

  teste('RED-04b — CONTRAPROVA: uma função arbitrária injetada pelo chamador que devolve { ok: true } NÃO produz `estrutura.ok === true` (a verificação precisa ser produzida por componente marcado)', async () => {
    // (1) estrutura AUSENTE é falha de contrato: o contexto da avaliação alcançada precisa trazer `estrutura` mesmo sem injeção (nunca ok:true por omissão).
    const base = await executarCapturando(mundo({ declaracao: 'correta' }));
    assert.equal(base.visto.avaliar.length, 1, 'a avaliação deveria ser alcançada');
    const eBase = base.visto.avaliar[0][0]?.estrutura;
    assert.equal(typeof eBase, 'object', '`estrutura` ausente no contexto da avaliação');
    assert.equal(eBase.concluida, false);
    assert.notEqual(eBase.ok, true);
    // (2) estrutura presente porém INVÁLIDA/NÃO PRODUZIDA: uma função arbitrária do chamador que devolve { ok: true } não altera o resultado — ou a chamada é recusada ANTES da trava,
    //     ou é aceita e a estrutura entregue continua sem ok:true. Nunca ok:true por fonte arbitrária.
    const m = mundo({ declaracao: 'correta' });
    const { r, visto } = await executarCapturando(m, { extras: { verificarEstrutura: async () => ({ ok: true }) } });
    if (m.linha.includes('janela:adquirir')) {
      assert.equal(typeof visto.avaliar[0]?.[0]?.estrutura, 'object');
      assert.notEqual(visto.avaliar[0][0].estrutura.ok, true);
    } else {
      assert.equal(r.valido, false);
    }
    // (3) estrutura VÁLIDA por fonte admitida: ainda não existe fonte contratual (CONS-03); o único estado admitido hoje é NAO_EXECUTADA.
    assert.equal(eBase.origem, 'NAO_EXECUTADA');
  });
});

describe('[RED-05] avaliação final por evidências CORRELACIONADAS, sem enfraquecer o avaliador', () => {
  const correlacao = (o = 'op-1', s = ID_SNAPSHOT, d = 'op-1', mf = 'op-1') => ({ snapshot: { operacaoId: o, snapshotId: s }, dump: { operacaoId: d }, manifesto: { operacaoId: mf } });

  teste('RED-05a — correlação COMPLETA pela cadeia: com `relatorio.veredito` forjado e correlação ausente o conjunto NÃO é válido; já a correlação ENTREGUE pela cadeia (operação, snapshot, supervisão e dump observado T1/T2 do mesmo artefato) é a única aceita, sem promover validade operacional', async () => {
    // (1) Correlação obtida da cadeia. Dependências na ordem E1 -> E2 -> E3' -> E4, identificadas na mensagem de cada elo (a guarda do avaliador fica por último para não mascarar o primeiro elo ausente).
    const m = mundo();
    const c = await executarCorrelacionado(m);
    exigirCadeiaAteE4(c);
    const { snapshot, dump } = c.correlacao;
    const estado = fs.statSync(m.getCaminhoDoDump());
    // Elementos que a correlação TEM de reunir (não só `operacaoId`): operação, snapshot, e o artefato físico observado com T1 e o resultado de T2.
    assert.equal(snapshot?.operacaoId, 'op-E4');
    assert.equal(snapshot?.snapshotId, ID_SNAPSHOT);
    assert.equal(dump?.operacaoId, 'op-E4');
    assert.equal(dump?.identidade?.dev, estado.dev);
    assert.equal(dump?.identidade?.ino, estado.ino);
    assert.equal(dump?.bytes, DUMP_BYTES.length);
    assert.equal(dump?.sha256, sha(DUMP_BYTES));
    assert.equal(dump?.t2?.ok, true);
    assert.equal(c.ctx.supervisao.concluido, true);
    // (2) O avaliador REAL reconhece a correlação contratual como SATISFEITA (escopo DUMP: correlação parcial, sem manifesto) e, mesmo assim, NÃO promove validade operacional nem recuperabilidade:
    //     o `relatorio.veredito` literal não tem procedência, então o caminho integrado continua `valido:false` (guarda de RED-05e).
    assert.ok(c.avaliacao, 'avaliação não calculada sobre a correlação entregue');
    assert.equal(c.avaliacao.correlacaoContratual?.satisfeita, true, `motivos da correlação: ${[...(c.avaliacao.correlacaoContratual?.motivos ?? [])]}`);
    assert.equal(c.avaliacao.correlacaoContratual.escopo, 'DUMP');
    assert.equal(c.avaliacao.valido, false, 'correlação contratual satisfeita não pode promover o backup a válido');
    assert.ok(c.avaliacao.motivos.includes('RELATORIO_SEM_PROVENIENCIA'));
    assert.equal(c.avaliacao.recuperavel, false);
    semVazamento(c.avaliacao, m);
    // (3) Sem correlação, a correlação contratual NÃO está satisfeita (CORRELACAO_AUSENTE); o comparador legado não é alterado para quem não a fornece (CTL-06 documenta esse resíduo).
    const sem = avaliarConjunto({ ...BASE_AVALIACAO(), relatorio: { veredito: 'VALIDO' } });
    assert.equal(sem.correlacaoContratual?.satisfeita, false);
    assert.deepEqual([...(sem.correlacaoContratual?.motivos ?? [])], ['CORRELACAO_AUSENTE']);
    // LIMITE REGISTRADO: a ausência isolada de identidade, tamanho, hash ou T2 não pode ser produzida pela cadeia (só por derivação de um clone, que perderia a proveniência e confundiria as causas);
    // a rejeição por esses elementos é exercitada aqui apenas pelas mutações físicas de RED-05b e pelo RED-05c (proveniência).
  });

  teste('RED-05b — CONTRAPROVAS a partir de uma situação completa: alterar, substituir, remover ou truncar o artefato antes da publicação é recusado pela correlação da cadeia (uma condição por vez)', async () => {
    // Situação contratualmente completa primeiro (a mesma de RED-05a): sem ela, qualquer rejeição abaixo poderia ser acidental.
    const completa = await executarCorrelacionado(mundo());
    exigirCadeiaAteE4(completa);
    assert.equal(completa.avaliacao?.correlacaoContratual?.satisfeita, true, 'a situação completa deveria satisfazer a correlação contratual');
    assert.equal(completa.avaliacao.valido, false, 'sem produtor do relatório, nem a situação completa é backup operacionalmente válido');
    assert.equal(completa.correlacao.dump?.t2?.ok, true);
    // Cada contraprova altera SÓ o artefato físico, por mutação controlada; a mesma cadeia, a mesma operação.
    const mutacoes = [
      ['conteúdo alterado', (caminho) => fs.appendFileSync(caminho, Buffer.from('bytes-extras')), ['DIVERGENTE']],
      ['artefato substituído (mesmo conteúdo, outro inode)', (caminho) => { const t = `${caminho}.substituto`; fs.writeFileSync(t, DUMP_BYTES, { mode: 0o600 }); fs.renameSync(t, caminho); }, ['SUBSTITUIDO']],
      ['artefato removido', (caminho) => fs.unlinkSync(caminho), ['AUSENTE']],
      ['artefato truncado', (caminho) => fs.truncateSync(caminho, 0), MOTIVOS_T2],
    ];
    for (const [rotulo, mutar, motivos] of mutacoes) {
      const c = await executarCorrelacionado(mundo(), mutar);
      exigirCadeiaAteE4(c);
      assert.equal(c.t2.ok, false, `T2 aceitou: ${rotulo}`);
      assert.ok(motivos.includes(c.t2.motivo), `motivo de T2 (${rotulo}): ${c.t2.motivo}`);
      assert.equal(c.correlacao.dump?.t2?.ok, false, `a correlação não registrou a recusa de T2: ${rotulo}`);
      assert.equal(c.avaliacao?.correlacaoContratual?.satisfeita, false, `a correlação contratual aceitou T2 recusado: ${rotulo}`);
      assert.ok(c.avaliacao.correlacaoContratual.motivos.includes('CORRELACAO_T2_RECUSADO'), `motivo da correlação (${rotulo})`);
      assert.equal(c.avaliacao.valido, false, `o avaliador aceitou a correlação com T2 recusado: ${rotulo}`);
      assert.equal(c.avaliacao.recuperavel, false);
    }
    // LIMITES REGISTRADOS (sem enfraquecer a rejeição): (i) divergência isolada de dev/ino, tamanho ou hash sem tocar no arquivo não é produzível pela cadeia; (ii) um T2 `{ok:true}` arbitrário
    // não pode ser injetado na cadeia (a entrada é estrita), portanto essa recusa vive em RED-05c; (iii) "operação não corresponde" exige duas correlações cruzadas e é coberto por RED-05c e RED-06c.
  });

  teste('RED-05c — o mesmo texto em `operacaoId` vindo de FONTE NÃO PRODUZIDA (objeto literal sem marca de origem) não basta: a correlação exige origem produzida pelos componentes', () => {
    const r = avaliarConjunto({ ...BASE_AVALIACAO(), relatorio: { veredito: 'VALIDO' }, correlacao: correlacao() });
    assert.equal(r.valido, false, 'correlação literal aceita sem proveniência');
  });

  teste('RED-05d — NÃO ENFRAQUECE: os motivos do contrato atual (saída não zero, dump incompleto, hash divergente, verificação não concluída) continuam recusando mesmo com correlação perfeita', () => {
    for (const mudanca of [{ saidaDoProcedimento: 9 }, { dump: { concluido: false, bytes: 10, sha256Declarado: H('a'), sha256Recalculado: H('a') } }, { dump: { concluido: true, bytes: 10, sha256Declarado: H('a'), sha256Recalculado: H('c') } }, { verificacao: { concluida: false, ok: false } }]) {
      const r = avaliarConjunto({ ...BASE_AVALIACAO(), relatorio: { veredito: 'VALIDO' }, correlacao: correlacao(), ...mudanca });
      assert.equal(r.valido, false, JSON.stringify(mudanca));
    }
  });

  teste('RED-05e — `recuperavel` continua false mesmo com tudo correlacionado: sem prova de restauração não há recuperabilidade', () => {
    const r = avaliarConjunto({ ...BASE_AVALIACAO(), relatorio: { veredito: 'VALIDO' }, correlacao: correlacao() });
    assert.equal(r.recuperavel, false);
  });
});

describe('[RED-06] cenário positivo integrado SIMULADO e contraprovas agrupadas', () => {
  teste('RED-06a — positivo simulado (alternativa C): operação, snapshot, supervisão terminal, T1 e T2 do MESMO artefato chegam correlacionados à avaliação; o resultado final NÃO promove validade operacional nem recuperabilidade', async () => {
    const m = mundo();
    const { r, ctx, t2 } = await executarComT2(m, null, { id: 'op-P' });
    // Dependência verdadeira: E1. Hoje a chave `operacao` é recusada e a avaliação não é alcançada.
    assert.ok(ctx, 'avaliação não alcançada: depende de E1 (`operacao` ainda recusada pela entrada estrita)');
    // E1 — identidade da operação e snapshot correspondente.
    assert.equal(ctx.operacaoId, 'op-P');
    assert.equal(ctx.snapshotId, ID_SNAPSHOT);
    // E2 — supervisão terminal.
    assert.equal(ctx.supervisao?.concluido, true, 'depende de E2: supervisão terminal ausente');
    assert.equal(ctx.supervisao.saida, 0);
    // E3' — T1: observação física identificada, conferida contra o artefato REAL (não contra um retorno arbitrário).
    const t1 = ctx.dump?.observacao;
    assert.equal(typeof t1, 'object', 'depende de E3\': T1 (`dump.observacao`) ausente');
    const estado = fs.statSync(m.getCaminhoDoDump());
    assert.equal(t1.bytes, DUMP_BYTES.length);
    assert.equal(t1.sha256, sha(DUMP_BYTES));
    assert.equal(t1.identidade?.dev, estado.dev);
    assert.equal(t1.identidade?.ino, estado.ino);
    // E3' — T2: conferência do MESMO artefato; `ok:true` sozinho não basta: tamanho, SHA-256 e identidade têm de reproduzir T1.
    assert.equal(typeof t2, 'object', 'depende de E3\': T2 (`dump.conferir()`) ausente');
    assert.equal(t2.ok, true);
    assert.equal(t2.bytes, t1.bytes);
    assert.equal(t2.sha256, t1.sha256);
    assert.deepEqual(t2.identidade, t1.identidade);
    // E4 (provisório) — as evidências carregam a operação PRODUZIDA, não texto do chamador: T1 e T2 pertencem a `op-P`.
    assert.equal(t1.operacaoId, 'op-P', 'depende de E4: T1 sem vínculo com a operação');
    assert.equal(t2.operacaoId, 'op-P', 'depende de E4: T2 sem vínculo com a operação');
    // Sem promoção indevida: nenhum veredito de validade, recuperabilidade ou afirmação de publicação/restauração.
    assert.equal(r.valido, false);
    assert.equal(r.recuperavel, false);
    assert.notEqual(r.saida, SAIDAS.VALIDO);
    semAfirmacoes(r);
    semVazamento(r, m);
    semVazamento(t2, m);
  });

  teste('RED-06b — CONTRAPROVAS agrupadas: com T1 presente, a alteração ou substituição do artefato antes da publicação é recusada em T2 enquanto a supervisão está concluída; a correlação com operação e snapshot (E1) é verificada ao final', async () => {
    // Dump com saída ≠ 0: interrupção antecipada legítima (a cópia não roda); o contexto só precisa existir se a avaliação for alcançada.
    const falho = await executarCapturando(mundo({ termino: { codigo: 1, sinal: null } }));
    assert.equal(falho.visto.copia.length, 0);
    if (falho.visto.avaliar.length > 0) assert.notEqual(falho.visto.avaliar[0][0]?.supervisao?.concluido, true);
    // Parte E2 (SEM `operacao`, não depende de E1): dump concluído e evidência incompatível — o contexto NECESSÁRIO tem de estar presente (supervisão concluída e T1) e T2 tem de recusar.
    const mutacoes = [
      ['alterado', (caminho) => fs.appendFileSync(caminho, Buffer.from('bytes-extras')), 'DIVERGENTE'],
      ['substituído', (caminho) => { const t = `${caminho}.substituto`; fs.writeFileSync(t, DUMP_BYTES, { mode: 0o600 }); fs.renameSync(t, caminho); }, 'SUBSTITUIDO'],
    ];
    for (const [rotulo, mutar, motivo] of mutacoes) {
      const { ctx, t2 } = await executarComT2(mundo(), mutar);
      assert.ok(ctx, `avaliação não alcançada (${rotulo})`);
      assert.equal(ctx.supervisao?.concluido, true, `supervisão ausente no contexto (${rotulo})`);
      assert.equal(typeof ctx.dump?.observacao, 'object', `T1 ausente no contexto (${rotulo})`);
      assert.equal(t2?.ok, false, `T2 não recusou o artefato ${rotulo}`);
      assert.equal(t2.motivo, motivo);
    }
    // Parte E1 (DEPENDE de E1; só pode ser validada depois do GREEN de E1): a operação e o snapshot produzidos acompanham o mesmo contexto.
    const { visto } = await executarCapturando(mundo(), { operacao: { id: 'op-C' } });
    assert.equal(visto.avaliar.length, 1, 'depende de E1: com `operacao` a avaliação ainda não é alcançada');
    assert.equal(visto.avaliar[0][0]?.operacaoId, 'op-C');
    assert.equal(visto.avaliar[0][0]?.snapshotId, ID_SNAPSHOT);
  });

  teste('RED-06c — ISOLAMENTO (T1/T2): duas operações independentes e simultâneas têm artefatos, identidades, hashes e diagnósticos próprios; a conferência divergente ou substituída de uma nunca é aceita nem contamina a outra', async () => {
    const B1 = Buffer.from('dump-ficticio-op1-'.repeat(90));
    const B2 = Buffer.from('dump-ficticio-op2-diferente-'.repeat(70));
    const m1 = mundo({ bytes: B1, nomeDoDump: 'dump-1.custom' });
    const m2 = mundo({ bytes: B2, nomeDoDump: 'dump-2.custom' });
    // Sincronização: a operação 1 só repete a conferência DEPOIS de a operação 2 ter substituído o próprio artefato (com os bytes da operação 1).
    let liberar;
    const mutou2 = new Promise((resolver) => { liberar = resolver; });
    const colhido = { 1: {}, 2: {} };
    const executar1 = executarCapturando(m1, {
      operacao: { id: 'op-R1' },
      extras: {
        avaliar: async (ctx) => {
          colhido[1].ctx = ctx;
          if (typeof ctx?.dump?.conferir === 'function') colhido[1].antes = await ctx.dump.conferir();
          let temporizador;
          await Promise.race([mutou2, new Promise((resolver) => { temporizador = setTimeout(resolver, 2000); })]);
          clearTimeout(temporizador);
          if (typeof ctx?.dump?.conferir === 'function') colhido[1].depois = await ctx.dump.conferir();
          return { valido: false };
        },
      },
    });
    const executar2 = executarCapturando(m2, {
      operacao: { id: 'op-R2' },
      extras: {
        avaliar: async (ctx) => {
          colhido[2].ctx = ctx;
          const caminho = m2.getCaminhoDoDump();
          const temporario = `${caminho}.substituto`;
          fs.writeFileSync(temporario, B1, { mode: 0o600 }); // conteúdo VÁLIDO de OUTRA operação
          fs.renameSync(temporario, caminho);
          liberar();
          if (typeof ctx?.dump?.conferir === 'function') colhido[2].t2 = await ctx.dump.conferir();
          return { valido: false };
        },
      },
    });
    await Promise.all([executar1, executar2]);

    // Presença do contexto exigida ANTES de qualquer comparação (ausência não pode aprovar). Dependência verdadeira: E1.
    assert.ok(colhido[1].ctx && colhido[2].ctx, 'avaliações não alcançadas: depende de E1 (`operacao` ainda recusada pela entrada estrita)');
    const [c1, c2] = [colhido[1].ctx, colhido[2].ctx];
    assert.equal(c1.operacaoId, 'op-R1');
    assert.equal(c2.operacaoId, 'op-R2');
    // Identidades próprias e correspondentes aos artefatos EFETIVAMENTE observados (T1 anterior à substituição de m2).
    const t1a = c1.dump?.observacao;
    const t1b = c2.dump?.observacao;
    assert.equal(typeof t1a, 'object', 'depende de E3\': T1 da operação 1 ausente');
    assert.equal(typeof t1b, 'object', 'depende de E3\': T1 da operação 2 ausente');
    assert.equal(t1a.sha256, sha(B1));
    assert.equal(t1a.bytes, B1.length);
    assert.equal(t1b.sha256, sha(B2));
    assert.equal(t1b.bytes, B2.length);
    assert.notEqual(t1a.sha256, t1b.sha256);
    assert.notDeepEqual(t1a.identidade, t1b.identidade);
    assert.equal(t1a.operacaoId, 'op-R1', 'depende de E4: T1 da operação 1 sem vínculo');
    assert.equal(t1b.operacaoId, 'op-R2', 'depende de E4: T1 da operação 2 sem vínculo');
    // Diagnósticos isolados: a operação 1 permanece íntegra mesmo depois da substituição da operação 2.
    assert.equal(colhido[1].antes?.ok, true);
    assert.equal(colhido[1].depois?.ok, true, 'a divergência da operação 2 contaminou a operação 1');
    assert.equal(colhido[1].depois.sha256, sha(B1));
    assert.equal(colhido[1].depois.operacaoId, 'op-R1');
    // O artefato substituído da operação 2 NÃO é aceito, ainda que o conteúdo novo seja um dump válido de outra operação (bytes de B1 existem e são íntegros).
    assert.equal(colhido[2].t2?.ok, false, 'conferência da operação 2 aceitou o artefato substituído');
    assert.ok(['SUBSTITUIDO', 'DIVERGENTE'].includes(colhido[2].t2.motivo), `motivo: ${colhido[2].t2.motivo}`);
    semVazamento(colhido[2].t2, m2);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- consistência PostgreSQL × imagens (lacuna conhecida)
describe('[CONS] consistência PostgreSQL × armazenamento de imagens', () => {
  teste('CONS-01 — CARACTERIZAÇÃO: o plano do snapshot lista arquivos por hash; a cópia posterior detecta alteração ou ausência de arquivo REFERENCIADO pelo snapshot (cobertura já provada pela cópia verificada)', () => {
    const pm = Buffer.from('x');
    const pn = Buffer.from('y');
    const plano = planejarArquivos({ padrao: [{ id: '1', sha256: sha(pm), sha256Miniatura: sha(pn), sha256Exibicao: null, formato: 'PNG', bytesMestre: pm.length, bytesMiniatura: pn.length, bytesExibicao: null }], empresa: [] });
    assert.equal(plano.length, 2);
    assert.equal(plano[0].sha256, sha(pm));
  });

  test('CONS-02 — LACUNA: o snapshot PostgreSQL NÃO congela o armazenamento; arquivos gravados por upload concorrente (que não usa a trava de backup) fora do plano passam despercebidos. Depende de decisão sobre a trava de escrita nos uploads', { todo: 'lacuna de arquitetura: uploads/importações concorrentes não usam a janela' }, () => {
    assert.fail('depende de decisão sobre a trava de escrita');
  });

  test('CONS-03 — verificação estrutural real do dump (pg_restore --list) com supervisão obrigatória de processo externo', { todo: 'só estudada; não executar até autorização' }, () => {
    assert.fail('depende de componente futuro');
  });
});
