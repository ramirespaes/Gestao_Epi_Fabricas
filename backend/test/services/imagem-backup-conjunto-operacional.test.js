'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { criarCopiaDeImagens } = require('../../src/services/imagem-backup-copia.service');
const { criarSelagem } = require('../../src/services/imagem-backup-selagem.service');
const { criarComposicaoDoConjunto } = require('../../src/services/imagem-backup-composicao.service');
const { executarBackup, avaliarConjunto, SAIDAS, ESTADOS_DA_JANELA, ESTADOS_DA_FINALIZACAO } = require('../../src/services/imagem-backup.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-VINCULO-CONJUNTO-OPERACIONAL-1): SOMENTE CONTROLES DIAGNÓSTICOS. O ponto de parada obrigatório do comando foi acionado e este arquivo
 * NÃO contém testes RED do módulo `criarEtapasDoConjunto`, porque os contratos reais mostram que o fluxo declararia backup VÁLIDO (`valido: true`, saída 0) com evidência de dump FICTÍCIA:
 * escrever expectativas de integração agora legitimaria esse resultado. Nada aqui altera produção, usa PostgreSQL, `pg_dump`, processo real ou imagens reais; só diretórios temporários
 * descartáveis (prefixo `gepi-vinculo-test-`) com dados fictícios.
 *
 * CONTRATOS REAIS CONFIRMADOS (executados abaixo, não presumidos):
 *   - O COORDENADOR (`executarBackup`) decide `valido: true` / saída 0 exclusivamente por `avaliar(...)` devolver um objeto com `valido === true` (depois de todas as etapas com `ok === true`, posse
 *     confirmada e sem pedido de parada). Ele NÃO examina evidência alguma: nem o dump, nem a composição, nem o `avaliarConjunto`. Quem produz a classificação positiva é a função `avaliar`
 *     injetada pelo chamador (DIAG-01/02).
 *   - O `avaliarConjunto` completo (que EXIGE `saidaDoProcedimento`, `relatorio.veredito`, `verificacao` e a evidência do dump) rejeita os mesmos dados que o coordenador aceitaria com um `avaliar`
 *     simples (DIAG-03): hoje NADA o liga ao coordenador e NINGUÉM produz esses elementos.
 *   - A evidência do dump só existe depois da etapa supervisionada concluída e com `liberarTravaPermitido === true`: se a supervisão não permite, a etapa seguinte (`copia`, onde a composição rodaria)
 *     NUNCA começa (DIAG-04); uma Promise resolvida com `ok: true` e sem `supervisao` equivale a retenção (DIAG-04b). O coordenador não distingue evento `exit`, fluxos fechados e grupo vazio:
 *     isso é do supervisor, e o coordenador só lê `concluido` e `liberarTravaPermitido`.
 *   - Ordem observada: dump (supervisionado) -> copia (composição) -> avaliar -> finalizar -> liberar (DIAG-05); composição pendente impede avaliar, finalizar e liberar (DIAG-06).
 *
 * INCOMPATIBILIDADE REGISTRADA: com `avaliar` = "composição ok" e dump fictício, o coordenador real devolve VÁLIDO. O significado de `valido: true` (Nível B/C) hoje é "o chamador disse que sim", não
 * "backup operacional validado" (Nível D). Decisão pendente de Ramires (ver relatório): o que alimentará `relatorio`, `verificacao` e `saidaDoProcedimento` do `avaliarConjunto`, e se a integração
 * pode ligar o coordenador a um `avaliar` que não os use.
 */

const PRAZO = 20000;
const PREFIXO = 'gepi-vinculo-test-';
const teste = (nome, fn) => test(nome, { timeout: PRAZO }, fn);
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
/** EVIDÊNCIA FICTÍCIA DE DUMP (double de teste): não existe dump PostgreSQL, leitura física, SHA-256 independente nem identidade de cluster. */
const DUMP_FICTICIO = Object.freeze({ concluido: true, bytes: 1234, sha256Declarado: H('7'), sha256Recalculado: H('7') });
const SUPERVISAO_PERMITE = Object.freeze({ concluido: true, liberarTravaPermitido: true });

const criadas = [];
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of criadas) if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO)) fs.rmSync(p, { recursive: true, force: true });
});

/** Cenário mínimo e fictício: uma imagem padrão (mestre + miniatura) copiada pela cópia REAL e composta pela composição REAL. */
async function cenario() {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
  fs.chmodSync(raiz, 0o700);
  criadas.push(raiz);
  const mestre = Buffer.from('padrao-mestre');
  const miniatura = Buffer.from('padrao-miniatura');
  const registros = { padrao: [{ id: '1', sha256: sha(mestre), sha256Miniatura: sha(miniatura), sha256Exibicao: null, formato: 'PNG', bytesMestre: mestre.length, bytesMiniatura: miniatura.length, bytesExibicao: null }], empresa: [] };
  const plano = planejarArquivos(registros);
  const origem = criarArmazenamentoImagens({ diretorio: path.join(raiz, 'origem') });
  const destino = criarArmazenamentoImagens({ diretorio: path.join(raiz, 'preparacao', 'imagens') });
  for (const item of plano) await origem.gravar(item.chave, [mestre, miniatura].find((b) => sha(b) === item.sha256), { maxBytes: 4096, sha256Esperado: item.sha256 });
  const area = path.join(raiz, 'preparacao');
  const contexto = Object.freeze({ snapshotId: '0-0-0', banco: Object.freeze({ nome: 'gestao_epi', oid: '16384' }), registros, plano });
  const copiar = criarCopiaDeImagens({ origem, destino, maxBytesPorArquivo: 4096 });
  return { raiz, area, contexto, plano, copiar };
}

function janelaFalsa(eventos) {
  return { adquirir: async () => ({ confirmarPosse: async () => ({ confirmada: true }), liberar: async () => { eventos.push('liberar'); return { liberada: true }; } }) };
}

/** Etapas do coordenador: snapshot e dump são doubles (nenhum PostgreSQL, nenhum processo); `copia` executa a COMPOSIÇÃO real. */
function etapas(eventos, c, opcoes = {}) {
  // `supervisao: undefined` explícito significa "sem supervisão" (um valor padrão de parâmetro o engoliria).
  const supervisao = Object.hasOwn(opcoes, 'supervisao') ? opcoes.supervisao : SUPERVISAO_PERMITE;
  const { aoCopiar } = opcoes;
  const guardado = { composicao: null, contagemDaCopia: 0 };
  const copiarContado = async (contexto) => { guardado.contagemDaCopia += 1; return c.copiar(contexto); };
  const composicao = criarComposicaoDoConjunto({ copiar: copiarContado, selagem: criarSelagem(), area: c.area, conjuntoId: 'conjunto-vinculo-0001' });
  return {
    guardado,
    lista: [
      { nome: 'snapshot', executar: async () => { eventos.push('snapshot'); return { ok: true }; } },
      { nome: 'dump', supervisionada: true, executar: async () => { eventos.push('dump:fim'); return supervisao === undefined ? { ok: true } : { ok: true, supervisao }; } },
      {
        nome: 'copia',
        executar: async () => {
          eventos.push('copia:inicio');
          if (aoCopiar) await aoCopiar();
          guardado.composicao = await composicao.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
          eventos.push('copia:fim');
          return { ok: guardado.composicao.ok === true };
        },
      },
    ],
  };
}

// ------------------------------------------------------------------------------------------------------------------------------- diagnósticos
describe('[DIAG] controles diagnósticos do coordenador real: o que significa `valido: true` hoje', () => {
  teste('DIAG-01 — NÍVEL C POSITIVO COM EVIDÊNCIA FICTÍCIA: com `avaliar` = "a composição foi ok", o coordenador real devolve VÁLIDO (saída 0, trava liberada), embora o dump seja um double. Quem classificou foi o `avaliar` injetado; o coordenador não examina evidência', async () => {
    const c = await cenario();
    const eventos = [];
    const e = etapas(eventos, c);
    const r = await executarBackup({ janela: janelaFalsa(eventos), etapas: e.lista, avaliar: async () => ({ valido: e.guardado.composicao !== null && e.guardado.composicao.ok === true }), finalizar: async () => { eventos.push('finalizar'); return { concluida: true }; } });
    // Nível A (composição lógica) verdadeiro; Nível B (avaliar) verdadeiro; Nível C (coordenador) POSITIVO; Nível D (backup operacional validado) AUSENTE: o dump é fictício.
    assert.equal(e.guardado.composicao.ok, true);
    assert.equal(e.guardado.composicao.selado, true);
    assert.equal(r.valido, true);
    assert.equal(r.saida, SAIDAS.VALIDO);
    assert.equal(r.janela, ESTADOS_DA_JANELA.LIBERADA);
    assert.equal(r.finalizacao, ESTADOS_DA_FINALIZACAO.CONCLUIDA);
    assert.equal(r.recuperavel, false, 'o coordenador nunca declara recuperável sem prova de restauração');
    assert.equal(Object.hasOwn(r, 'publicado'), false);
    assert.equal(e.guardado.contagemDaCopia, 1, 'a cópia real rodou uma única vez');
    assert.deepEqual(eventos, ['snapshot', 'dump:fim', 'copia:inicio', 'copia:fim', 'finalizar', 'liberar']);
  });

  teste('DIAG-02 — o coordenador aceita QUALQUER `avaliar` positivo: um `avaliar` que ignora a composição (ou a evidência) também dá VÁLIDO; e uma etapa `copia` que devolve `ok:true` apesar de a composição ter falhado seria invisível para ele', async () => {
    const c = await cenario();
    await c.copiar(c.contexto); // destino já ocupado: a composição abaixo falhará em COPIA
    const eventos = [];
    const e = etapas(eventos, c);
    e.lista[2] = { nome: 'copia', executar: async () => { e.guardado.composicao = await criarComposicaoDoConjunto({ copiar: c.copiar, selagem: criarSelagem(), area: c.area, conjuntoId: 'conjunto-vinculo-0001' }).compor({ contexto: c.contexto, dump: DUMP_FICTICIO }); return { ok: true }; } };
    const r = await executarBackup({ janela: janelaFalsa(eventos), etapas: e.lista, avaliar: async () => ({ valido: true }), finalizar: async () => ({ concluida: true }) });
    assert.equal(e.guardado.composicao.ok, false, 'a composição FALHOU');
    assert.equal(r.valido, true, 'e mesmo assim o coordenador classifica VÁLIDO: ele só enxerga `ok` e o que `avaliar` diz');
    assert.equal(r.saida, SAIDAS.VALIDO);
    assert.equal(r.recuperavel, false);
  });

  teste('DIAG-03 — o `avaliarConjunto` COMPLETO rejeita os mesmos dados: faltam `saidaDoProcedimento`, `relatorio.veredito` e `verificacao`, que NINGUÉM produz hoje; nada o liga ao coordenador', async () => {
    const c = await cenario();
    const copia = await c.copiar(c.contexto);
    const comp = await criarComposicaoDoConjunto({ copiar: async () => copia, selagem: criarSelagem(), area: c.area, conjuntoId: 'conjunto-vinculo-0001' }).compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.equal(comp.ok, true);
    const base = { manifesto: comp.manifesto, listaDoSnapshot: c.plano, dump: { ...DUMP_FICTICIO }, identidade: { ...comp.identidade } };
    const semElementos = avaliarConjunto(base);
    assert.equal(semElementos.valido, false);
    assert.equal(semElementos.recuperavel, false);
    assert.ok(semElementos.motivos.length >= 1);
    // com elementos que SÓ o teste inventa (relatório, verificação, saída 0) o avaliador completo aceitaria: o problema é a ausência de produtores confiáveis, não do avaliador
    const comInvencao = avaliarConjunto({ ...base, saidaDoProcedimento: 0, relatorio: { veredito: 'VALIDO' }, verificacao: { concluida: true, ok: true } });
    assert.equal(comInvencao.valido, true);
    assert.equal(comInvencao.recuperavel, false);
  });

  teste('DIAG-04 — a evidência do dump NÃO é consumível antes da conclusão comprovada da etapa supervisionada: com `liberarTravaPermitido: false` a etapa `copia` (onde a composição rodaria) nunca começa; `avaliar` não roda; a trava fica RETIDA e `liberar` não é chamado', async () => {
    const c = await cenario();
    const eventos = [];
    const e = etapas(eventos, c, { supervisao: { concluido: false, liberarTravaPermitido: false } });
    let avaliou = false;
    const r = await executarBackup({ janela: janelaFalsa(eventos), etapas: e.lista, avaliar: async () => { avaliou = true; return { valido: true }; }, finalizar: async () => { eventos.push('finalizar'); return { concluida: true }; } });
    assert.deepEqual(eventos, ['snapshot', 'dump:fim']);
    assert.equal(e.guardado.contagemDaCopia, 0);
    assert.equal(avaliou, false);
    assert.equal(r.valido, false);
    assert.equal(r.janela, ESTADOS_DA_JANELA.RETIDA);
    assert.equal(r.saida, SAIDAS.TRAVA_RETIDA);
    assert.equal(r.finalizacao, ESTADOS_DA_FINALIZACAO.ADIADA, 'o snapshot não é finalizado enquanto a supervisão exige retenção');
  });

  teste('DIAG-04b — uma etapa supervisionada que resolve `ok:true` SEM `supervisao` (a "Promise resolvida" isolada) vale como retenção: o coordenador exige o veredito da supervisão, não o fim de uma Promise', async () => {
    const c = await cenario();
    const eventos = [];
    const e = etapas(eventos, c, { supervisao: undefined });
    const r = await executarBackup({ janela: janelaFalsa(eventos), etapas: e.lista, avaliar: async () => ({ valido: true }), finalizar: async () => ({ concluida: true }) });
    assert.deepEqual(eventos, ['snapshot', 'dump:fim']);
    assert.equal(r.valido, false);
    assert.equal(r.janela, ESTADOS_DA_JANELA.RETIDA);
    assert.equal(e.guardado.contagemDaCopia, 0);
  });

  teste('DIAG-05 — ordem observada pelo coordenador real: snapshot -> dump (supervisionado) -> copia/composição -> avaliar -> finalizar -> liberar; a finalização do snapshot e a liberação são DELE, nunca da composição', async () => {
    const c = await cenario();
    const eventos = [];
    const e = etapas(eventos, c);
    await executarBackup({ janela: janelaFalsa(eventos), etapas: e.lista, avaliar: async () => { eventos.push('avaliar'); return { valido: e.guardado.composicao.ok === true }; }, finalizar: async () => { eventos.push('finalizar'); return { concluida: true }; } });
    assert.deepEqual(eventos, ['snapshot', 'dump:fim', 'copia:inicio', 'copia:fim', 'avaliar', 'finalizar', 'liberar']);
  });

  teste('DIAG-06 — composição PENDENTE (promessa controlada pelo teste, sem esperas): enquanto não resolve, o coordenador não chama avaliar, finalizar nem liberar; ao resolver, segue a ordem normal', async () => {
    const c = await cenario();
    const eventos = [];
    let liberarPendente;
    const pendente = new Promise((resolver) => { liberarPendente = resolver; });
    let iniciou;
    const iniciouComposicao = new Promise((resolver) => { iniciou = resolver; });
    const e = etapas(eventos, c, { aoCopiar: async () => { iniciou(); await pendente; } });
    const execucao = executarBackup({ janela: janelaFalsa(eventos), etapas: e.lista, avaliar: async () => { eventos.push('avaliar'); return { valido: true }; }, finalizar: async () => { eventos.push('finalizar'); return { concluida: true }; } });
    await iniciouComposicao;
    assert.deepEqual(eventos, ['snapshot', 'dump:fim', 'copia:inicio'], 'nada de avaliar, finalizar ou liberar durante a pendência');
    liberarPendente();
    const r = await execucao;
    assert.deepEqual(eventos, ['snapshot', 'dump:fim', 'copia:inicio', 'copia:fim', 'avaliar', 'finalizar', 'liberar']);
    assert.equal(r.valido, true);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- pendências
describe('[PENDÊNCIAS] registradas, NÃO especificadas: dependem de decisão de Ramires', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('VIN-01 — significado de `valido: true`: decidir o que o `avaliar` ligado ao coordenador pode usar (o `avaliarConjunto` completo exige `saidaDoProcedimento`, `relatorio.veredito` e `verificacao`, sem produtores) antes de escrever qualquer RED de integração', 'DECISÃO PENDENTE');
  todo('VIN-02 — produtor REAL da evidência do dump (tamanho e SHA-256 dos bytes do arquivo estável, associado à execução e ao arquivo criados por ESTA operação); hoje só um double fictício', 'incremento próprio');
  todo('VIN-03 — RED de `criarEtapasDoConjunto` (execução única da cópia, concorrência, falhas, interrupção, posse), a escrever somente depois da decisão VIN-01', 'aguarda decisão');
  todo('VIN-04 — composição pendente indefinidamente prende a trava e o snapshot: exige cancelamento seguro em cópia e selagem (sem prazo arbitrário)', 'incremento próprio');
  todo('VIN-05 — contenção real de processos, identidade de grupos e descendentes, trava de escrita em todos os escritores, snapshot que não congela arquivos, preparação parcial, publicação atômica, durabilidade e restauração independente', 'bloqueios operacionais');
});
