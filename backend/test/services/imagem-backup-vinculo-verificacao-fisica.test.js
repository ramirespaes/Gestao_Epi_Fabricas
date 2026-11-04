'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { criarCopiaDeImagens } = require('../../src/services/imagem-backup-copia.service');
const { criarSelagem } = require('../../src/services/imagem-backup-selagem.service');
const { criarComposicaoDoConjunto } = require('../../src/services/imagem-backup-composicao.service');
const { criarVerificadorDeImagensCopiadas } = require('../../src/services/imagem-backup-verificacao-imagens-copiadas.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-VINCULO-VERIFICACAO-FISICA-COMPOSICAO-1): como inserir a VERIFICAÇÃO FÍSICA das imagens copiadas na composição lógica SEM rodar a cópia
 * duas vezes e SEM alterar nenhum contrato aprovado. Só dados FICTÍCIOS em diretórios temporários exclusivos (prefixo `gepi-vinculo-vf-test-`); nada toca PostgreSQL, `pg_dump`, processo real ou imagens
 * reais. A evidência do dump é FICTÍCIA e só existe para a composição aceitar o manifesto: nada aqui é backup PostgreSQL válido, publicado ou recuperável.
 *
 * CONTRATOS REAIS CONFIRMADOS (CTL-01 a CTL-03 executam):
 *   - a composição chama `copiar(contexto)` UMA vez, usa só `copia.ok === true` para decidir e, em falha, repassa APENAS `copia.falha.codigo` se estiver num CONJUNTO FIXO (PLANO_INVALIDO, ORIGEM_AUSENTE,
 *     ORIGEM_INVALIDA, DESTINO_INVALIDO, DESTINO_EXISTENTE, INTEGRIDADE_DIVERGENTE, LIMITE_EXCEDIDO, COPIA_FALHOU), no estágio COPIA; qualquer outro código vira COPIA_FALHOU. O diagnóstico da verificação
 *     física (divergências por chave, motivo) NÃO atravessa a composição: ela só devolve { estagio, codigo };
 *   - o mesmo objeto devolvido por `copiar` segue para `construirManifesto`, que exige a forma EXATA do resultado da cópia (chaves `arquivos`, `completo`, `copiados`, `falha`, `ok`): carregar a verificação
 *     DENTRO do resultado da cópia é recusado (MANIFESTO_INVALIDO). Logo o diagnóstico precisa de um canal LATERAL;
 *   - o verificador físico recebe `{ plano, copia }` (o plano vem de `contexto.plano`) e devolve { concluida:true, ok:true, examinados, bytes } | { concluida:true, ok:false, examinados, divergencias } |
 *     { concluida:false, ok:false, motivo }.
 *
 * VIABILIDADE: é possível sem mudar nenhum contrato. A etapa fica ENTRE a composição e a cópia real: a composição recebe `copiarVerificado` no lugar de `copiar`. Em sucesso, `copiarVerificado` devolve o
 * resultado ORIGINAL da cópia, intacto (a composição segue igual). Em qualquer outra situação devolve um resultado de FALHA no formato da cópia ({ ok:false, completo:false, arquivos:[], copiados:0,
 * falha:{ codigo, chave:null } }) com um código JÁ existente no conjunto da composição, e o diagnóstico real fica no canal lateral.
 *
 * INTERFACE PROVISÓRIA (nada em produção): src/services/imagem-backup-copia-verificada.service.js exporta `criarEtapaDeCopiaVerificada({ copiar, verificador })` (ESTRITO; TypeError se inválido; `copiar` função,
 * `verificador.verificar` função, ambos capturados UMA vez, com o `this` original) -> congelado { copiarVerificado, obterVerificacao }, INTERNO e criado POR OPERAÇÃO:
 *   - `copiarVerificado(contexto)`: assíncrona, UMA execução por instância (reserva SÍNCRONA antes do primeiro await: qualquer chamada posterior, simultânea ou não, inclusive depois de falha, recebe a falha
 *     genérica COPIA_FALHOU sem executar nada). Ordem: (1) `copiar(contexto)` uma vez; (2) só se a cópia for positiva e completa (`ok === true`, `completo === true`, `falha === null`), (3) `verificador.verificar({ plano:
 *     contexto.plano, copia })`; (4) classifica o retorno SEM confiar em objeto "truthy": positivo exige as chaves exatas { bytes, concluida, examinados, ok }, concluida e ok verdadeiros e `examinados` igual ao
 *     tamanho do plano; divergência exige { concluida:true, ok:false, examinados, divergencias } com divergências não vazias, { chave (do plano), codigo } e codigo em ARQUIVO_AUSENTE | ARQUIVO_INVALIDO |
 *     TAMANHO_DIVERGENTE | SHA256_DIVERGENTE; inconclusivo exige { concluida:false, ok:false, motivo } com motivo em ENTRADA_INVALIDA | LEITURA_FALHOU; todo o resto é retorno inválido;
 *   - código de falha levado à composição: divergência comprovada = INTEGRIDADE_DIVERGENTE (código já existente, mesmo sentido); inconclusiva, retorno inválido, exceção ou rejeição = COPIA_FALHOU; falha da cópia
 *     = o resultado ORIGINAL da cópia (que a composição já sabe classificar). Nenhum estágio novo;
 *   - `obterVerificacao()`: síncrona, NÃO lê arquivo nem chama o verificador. Antes da conclusão definitiva devolve `null` (nada positivo disponível). Depois, um objeto congelado e estável por operação:
 *     { classe: 'INTEGRA', verificacao } | { classe: 'DIVERGENCIA_COMPROVADA', verificacao } | { classe: 'INCONCLUSIVA', verificacao } (verificacao = cópia congelada do retorno original do verificador, ou
 *     null se ele lançou/rejeitou) | { classe: 'RETORNO_INVALIDO' } | { classe: 'NAO_EXECUTADA' } (a cópia não foi positiva e completa: nenhuma verificação foi tentada). As quatro classes NUNCA se confundem.
 *   - Nada aqui constrói manifesto, sela, libera trava, finaliza snapshot, limpa ou repete a cópia, e a consulta não prova validade, publicação ou recuperabilidade.
 *
 * LIMITES: a verificação representa os arquivos no instante em que foram relidos; uma imagem pode mudar depois, antes de outra etapa (nenhuma imutabilidade, TOCTOU não excluído, sem trava que proteja todos os
 * escritores). Nada garante que o `verificador` esteja ligado ao MESMO destino que `copiar` usa: isso é da composição confiável (VF-08). O diagnóstico lateral só é confiável dentro de um adaptador confiável.
 *
 * COMO LER: o módulo NÃO existe; falhas por "módulo ausente" NÃO são provas comportamentais independentes. Os CTL-* passam hoje.
 */

const MODULO = 'src/services/imagem-backup-copia-verificada.service';
const modulo = () => exigirModulo(MODULO);
const PRAZO = 30000;
const PREFIXO = 'gepi-vinculo-vf-test-';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const CONJUNTO = 'conjunto-vf-0001';
const teste = (nome, fn) => test(nome, { timeout: PRAZO }, fn);
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const clone = (v) => JSON.parse(JSON.stringify(v));
/** EVIDÊNCIA FICTÍCIA DE DUMP: só para a composição aceitar o manifesto; não representa nenhum dump PostgreSQL. */
const DUMP_FICTICIO = Object.freeze({ concluido: true, bytes: 1234, sha256Declarado: H('7'), sha256Recalculado: H('7') });
const FALHA_GENERICA = Object.freeze({ ok: false, completo: false, arquivos: Object.freeze([]), copiados: 0, falha: Object.freeze({ codigo: 'COPIA_FALHOU', chave: null }) });

// ------------------------------------------------------------------------------------------------------------------------------- cenário
const raizes = [];
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of raizes) if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO)) fs.rmSync(p, { recursive: true, force: true });
});

/** Uma imagem padrão (sem exibição) e duas empresas com o MESMO diretório de hash e conteúdos diferentes: 8 arquivos. `omitir` = índice do plano que não é semeado na origem. */
async function cenario({ omitir = null } = {}) {
  const raiz = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
  fs.chmodSync(raiz, 0o700);
  raizes.push(raiz);
  const buf = (t) => Buffer.from(t, 'utf8');
  const padraoMestre = buf('padrao-mestre-conteudo');
  const padraoMiniatura = buf('padrao-miniatura-conteudo');
  const linha = (id, empresaId) => ({
    id: String(id), empresaId, sha256: H('c'), formato: 'PNG', sha256Mestre: sha(buf(`mestre-${empresaId}-conteudo`)), sha256Exibicao: sha(buf(`exib-${empresaId}-conteudo`)), sha256Miniatura: sha(buf(`mini-${empresaId}-conteudo`)),
    bytesMestre: buf(`mestre-${empresaId}-conteudo`).length, bytesExibicao: buf(`exib-${empresaId}-conteudo`).length, bytesMiniatura: buf(`mini-${empresaId}-conteudo`).length,
  });
  const conteudos = [padraoMestre, padraoMiniatura, ...[7, 8].flatMap((e) => [buf(`mestre-${e}-conteudo`), buf(`exib-${e}-conteudo`), buf(`mini-${e}-conteudo`)])];
  const registros = {
    padrao: [{ id: '1', sha256: sha(padraoMestre), sha256Miniatura: sha(padraoMiniatura), sha256Exibicao: null, formato: 'PNG', bytesMestre: padraoMestre.length, bytesMiniatura: padraoMiniatura.length, bytesExibicao: null }],
    empresa: [linha(1, 7), linha(2, 8)],
  };
  const plano = planejarArquivos(registros);
  const origem = criarArmazenamentoImagens({ diretorio: path.join(raiz, 'origem') });
  const raizDoDestino = path.join(raiz, 'preparacao', 'imagens');
  const destino = criarArmazenamentoImagens({ diretorio: raizDoDestino });
  for (let i = 0; i < plano.length; i += 1) {
    if (i === omitir) continue;
    await origem.gravar(plano[i].chave, conteudos.find((c) => sha(c) === plano[i].sha256), { maxBytes: 4096, sha256Esperado: plano[i].sha256 });
  }
  const contexto = Object.freeze({ snapshotId: '0-0-0', banco: Object.freeze({ nome: 'gestao_epi', oid: '16384' }), registros, plano });
  const fisico = (chave) => path.join(fs.realpathSync(raizDoDestino), chave);
  return { raiz, area: path.join(raiz, 'preparacao'), plano, contexto, origem, destino, fisico, copiarReal: criarCopiaDeImagens({ origem, destino, maxBytesPorArquivo: 4096 }) };
}

/**
 * Operação completa com espiões que DELEGAM aos módulos reais: copiar (conta e pode alterar o destino logo depois da cópia), verificador físico (conta e registra os argumentos; pode ser substituído), selagem
 * (registra eventos). A composição REAL recebe `copiarVerificado` da etapa.
 */
async function operacao({ omitir = null, alterarDepoisDaCopia = null, substituto = null } = {}) {
  const c = await cenario({ omitir });
  const eventos = [];
  const contagem = { copiar: 0, fisica: 0, selar: 0 };
  const argumentosDaFisica = [];
  const resultadosDaCopia = [];
  const copiar = async (contexto) => {
    contagem.copiar += 1;
    eventos.push('copiar:inicio');
    const r = await c.copiarReal(contexto);
    resultadosDaCopia.push(r);
    if (alterarDepoisDaCopia) await alterarDepoisDaCopia(c, r);
    eventos.push('copiar:fim');
    return r;
  };
  const real = criarVerificadorDeImagensCopiadas({ destino: c.destino });
  const verificador = {
    async verificar(entrada) {
      contagem.fisica += 1;
      eventos.push('fisica:inicio');
      argumentosDaFisica.push(entrada);
      const r = substituto ? await substituto(entrada, real) : await real.verificar(entrada);
      eventos.push('fisica:fim');
      return r;
    },
  };
  const selagemReal = criarSelagem();
  const selagem = {
    selar: async (e) => { contagem.selar += 1; eventos.push('selar'); return selagemReal.selar(e); },
    verificar: async (e) => { eventos.push('verificar-selagem'); return selagemReal.verificar(e); },
  };
  const etapa = modulo().criarEtapaDeCopiaVerificada({ copiar, verificador });
  const composicao = criarComposicaoDoConjunto({ copiar: etapa.copiarVerificado, selagem, area: c.area, conjuntoId: CONJUNTO });
  const compor = () => composicao.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
  return { c, eventos, contagem, argumentosDaFisica, resultadosDaCopia, etapa, compor };
}

const semManifesto = (area) => assert.equal(fs.existsSync(area) && fs.readdirSync(area).some((n) => n.startsWith('manifesto.')), false, 'nenhum manifesto.* na área');
const semAfirmacoes = (valor) => {
  const t = JSON.stringify(valor).toLowerCase();
  for (const proibida of ['"valido"', 'recuper', 'publicad', 'restaur', 'veredito']) assert.equal(t.includes(proibida), false, proibida);
};
const semVazamento = (valor) => {
  const t = JSON.stringify(valor);
  for (const proibido of [SEGREDO, '/Users/privado', os.tmpdir(), PREFIXO]) assert.equal(t.includes(proibido), false, proibido);
};
const chaveDe = (c, filtro) => c.plano.find((p) => filtro(p.chave)).chave;
const profundamenteCongelado = (v) => {
  if (v === null || typeof v !== 'object') return true;
  return Object.isFrozen(v) && Object.values(v).every(profundamenteCongelado);
};

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: o que os contratos reais permitem ou exigem', () => {
  teste('CTL-01 — a composição real repassa de uma falha da cópia APENAS um código do conjunto fixo (INTEGRIDADE_DIVERGENTE passa; SHA256_DIVERGENTE/ARQUIVO_AUSENTE da verificação física viram COPIA_FALHOU) e nenhum diagnóstico atravessa: o canal lateral é necessário', async () => {
    const c = await cenario();
    const compor = (falha) => criarComposicaoDoConjunto({ copiar: async () => ({ ok: false, completo: false, arquivos: [], copiados: 0, falha }), selagem: criarSelagem(), area: c.area, conjuntoId: CONJUNTO }).compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.deepEqual({ ...(await compor({ codigo: 'INTEGRIDADE_DIVERGENTE', chave: null })).falha }, { estagio: 'COPIA', codigo: 'INTEGRIDADE_DIVERGENTE' });
    for (const codigo of ['SHA256_DIVERGENTE', 'ARQUIVO_AUSENTE', 'TAMANHO_DIVERGENTE', 'ARQUIVO_INVALIDO', 'LEITURA_FALHOU']) assert.deepEqual({ ...(await compor({ codigo, chave: null })).falha }, { estagio: 'COPIA', codigo: 'COPIA_FALHOU' }, codigo);
    const r = await compor({ codigo: 'SHA256_DIVERGENTE', chave: `7/${H('c')}/mestre.png`, divergencias: [{ chave: 'x', codigo: 'SHA256_DIVERGENTE' }] });
    assert.deepEqual(Object.keys(r.falha).sort(), ['codigo', 'estagio']);
    semManifesto(c.area);
  });

  teste('CTL-02 — o resultado da cópia segue INTACTO para `construirManifesto`, que exige a forma exata: um campo extra (como `verificacao`) no resultado da cópia é recusado (MANIFESTO/MANIFESTO_INVALIDO), então o diagnóstico não pode viajar dentro dele; o resultado original, sozinho, é aceito', async () => {
    const c = await cenario();
    const copia = await c.copiarReal(c.contexto);
    const compor = (resultado) => criarComposicaoDoConjunto({ copiar: async () => resultado, selagem: criarSelagem(), area: c.area, conjuntoId: CONJUNTO }).compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    const comExtra = await compor({ ...copia, verificacao: { concluida: true, ok: true } });
    assert.deepEqual({ ...comExtra.falha }, { estagio: 'MANIFESTO', codigo: 'MANIFESTO_INVALIDO' });
    semManifesto(c.area);
    assert.equal((await compor(copia)).ok, true);
  });

  teste('CTL-03 — a composição chama `copiar` EXATAMENTE uma vez por `compor`, com o contexto recebido; e o verificador físico real aceita o par (plano do contexto, resultado da cópia) tal como a cópia o entrega', async () => {
    const c = await cenario();
    const recebidos = [];
    const copiar = async (contexto) => { recebidos.push(contexto); return c.copiarReal(contexto); };
    const r = await criarComposicaoDoConjunto({ copiar, selagem: criarSelagem(), area: c.area, conjuntoId: CONJUNTO }).compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.equal(r.ok, true);
    assert.equal(recebidos.length, 1);
    assert.equal(recebidos[0], c.contexto);
    const copia = await criarCopiaDeImagens({ origem: c.origem, destino: criarArmazenamentoImagens({ diretorio: path.join(c.raiz, 'outro') }), maxBytesPorArquivo: 4096 })(c.contexto);
    const v = await criarVerificadorDeImagensCopiadas({ destino: criarArmazenamentoImagens({ diretorio: path.join(c.raiz, 'outro') }) }).verificar({ plano: c.contexto.plano, copia });
    assert.deepEqual({ concluida: v.concluida, ok: v.ok, examinados: v.examinados }, { concluida: true, ok: true, examinados: 8 });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- VF-01 / VF-02
describe('[VF-01 / VF-02] fluxo completo e cópia incompleta', () => {
  teste('VF-01 — FLUXO COMPLETO: cópia (1 vez) -> verificação física (1 vez, com o plano do contexto e o resultado ORIGINAL da cópia) -> manifesto -> selagem -> releitura da selagem; a composição devolve sucesso com o resultado da cópia intacto; `obterVerificacao()` é INTEGRA e NÃO relê nada; nada de recuperável/publicado', async () => {
    const o = await operacao();
    const r = await o.compor();
    assert.equal(r.ok, true);
    assert.equal(r.selado, true);
    assert.equal(r.arquivos, 8);
    assert.deepEqual(o.eventos, ['copiar:inicio', 'copiar:fim', 'fisica:inicio', 'fisica:fim', 'selar', 'verificar-selagem']);
    assert.deepEqual(o.contagem, { copiar: 1, fisica: 1, selar: 1 });
    assert.equal(o.argumentosDaFisica[0].plano, o.c.contexto.plano);
    assert.equal(o.argumentosDaFisica[0].copia, o.resultadosDaCopia[0]);
    const v = o.etapa.obterVerificacao();
    assert.deepEqual(Object.keys(v).sort(), ['classe', 'verificacao']);
    assert.equal(v.classe, 'INTEGRA');
    assert.deepEqual({ ...v.verificacao }, { concluida: true, ok: true, examinados: 8, bytes: o.c.plano.reduce((s, p) => s + fs.statSync(o.c.fisico(p.chave)).size, 0) });
    assert.equal(profundamenteCongelado(v), true);
    assert.equal(o.etapa.obterVerificacao(), v, 'estável');
    assert.equal(o.contagem.fisica, 1, 'a consulta não releu nada');
    semAfirmacoes(r);
    semAfirmacoes(v);
  });

  teste('VF-02a — CÓPIA REAL QUE FALHA (origem sem um arquivo): a verificação física NÃO roda; sem manifesto e sem selagem; a composição repassa o código original da cópia (ORIGEM_AUSENTE); a cópia parcial no destino é PRESERVADA; `obterVerificacao()` = NAO_EXECUTADA', async () => {
    const o = await operacao({ omitir: 7 });
    const r = await o.compor();
    assert.deepEqual({ ok: r.ok, selado: r.selado, ...r.falha }, { ok: false, selado: false, estagio: 'COPIA', codigo: 'ORIGEM_AUSENTE' });
    assert.deepEqual(o.eventos, ['copiar:inicio', 'copiar:fim']);
    assert.deepEqual(o.contagem, { copiar: 1, fisica: 0, selar: 0 });
    semManifesto(o.c.area);
    for (const item of o.c.plano.slice(0, 7)) assert.equal(await o.c.destino.existe(item.chave), true);
    assert.deepEqual({ ...o.etapa.obterVerificacao() }, { classe: 'NAO_EXECUTADA' });
  });

  teste('VF-02b — a cópia que NÃO é positiva e completa (ok verdadeiro mas incompleta, falha presente, não é objeto, lança, rejeita): nenhuma verificação é tentada; falha genérica COPIA_FALHOU (ou o código original quando a cópia declarou `ok:false`); sem eco; NAO_EXECUTADA', async () => {
    const c = await cenario();
    const real = await c.copiarReal(c.contexto);
    const casos = [
      ['ok verdadeiro mas incompleta', async () => ({ ...clone(real), completo: false }), 'COPIA_FALHOU'],
      ['ok verdadeiro com falha presente', async () => ({ ...clone(real), falha: { codigo: 'COPIA_FALHOU', chave: null } }), 'COPIA_FALHOU'],
      ['não é objeto', async () => 'ok', 'COPIA_FALHOU'],
      ['undefined', async () => undefined, 'COPIA_FALHOU'],
      ['lança com mensagem hostil', async () => { throw new TypeError(`${SEGREDO} /Users/privado`); }, 'COPIA_FALHOU'],
      ['ok:false com código conhecido', async () => ({ ok: false, completo: false, arquivos: [], copiados: 0, falha: { codigo: 'LIMITE_EXCEDIDO', chave: null } }), 'LIMITE_EXCEDIDO'],
    ];
    for (const [rotulo, copiar, codigoEsperado] of casos) {
      let verificacoes = 0;
      const etapa = modulo().criarEtapaDeCopiaVerificada({ copiar, verificador: { verificar: async () => { verificacoes += 1; return {}; } } });
      const resultado = await etapa.copiarVerificado(c.contexto);
      assert.equal(resultado.ok, false, rotulo);
      assert.equal(resultado.falha.codigo, codigoEsperado, rotulo);
      assert.equal(verificacoes, 0, `${rotulo}: sem verificação física`);
      assert.deepEqual({ ...etapa.obterVerificacao() }, { classe: 'NAO_EXECUTADA' }, rotulo);
      semVazamento(resultado);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- VF-03 / VF-04
describe('[VF-03 / VF-04] divergência comprovada, verificação inconclusiva e retorno inválido (nunca confundidos)', () => {
  const alteracoes = [
    ['ARQUIVO_AUSENTE', (c, chave) => fs.rmSync(c.fisico(chave))],
    ['TAMANHO_DIVERGENTE', (c, chave) => fs.truncateSync(c.fisico(chave), fs.statSync(c.fisico(chave)).size - 1)],
    ['SHA256_DIVERGENTE', (c, chave) => { const b = fs.readFileSync(c.fisico(chave)); fs.writeFileSync(c.fisico(chave), Buffer.alloc(b.length, 0x78)); }],
    ['ARQUIVO_INVALIDO', (c, chave) => { const alvo = path.join(c.raiz, 'alvo-externo'); fs.writeFileSync(alvo, fs.readFileSync(c.fisico(chave))); fs.rmSync(c.fisico(chave)); fs.symlinkSync(alvo, c.fisico(chave)); }],
  ];
  for (const [codigo, alterar] of alteracoes) {
    teste(`VF-03/VF-04A (${codigo}) — alteração REAL de bytes do destino depois da cópia e antes da verificação: divergência comprovada preservada em \`obterVerificacao()\` (${codigo}); a composição falha em COPIA/INTEGRIDADE_DIVERGENTE; sem manifesto, sem selagem, a cópia NÃO é repetida; nunca classificada como inconclusiva`, async () => {
      let chaveAlterada;
      const o = await operacao({ alterarDepoisDaCopia: async (c) => { chaveAlterada = chaveDe(c, (k) => k.startsWith('7/') && k.endsWith('mestre.png')); alterar(c, chaveAlterada); } });
      const r = await o.compor();
      assert.deepEqual({ ok: r.ok, selado: r.selado, ...r.falha }, { ok: false, selado: false, estagio: 'COPIA', codigo: 'INTEGRIDADE_DIVERGENTE' });
      assert.deepEqual(o.contagem, { copiar: 1, fisica: 1, selar: 0 });
      assert.deepEqual(o.eventos, ['copiar:inicio', 'copiar:fim', 'fisica:inicio', 'fisica:fim']);
      semManifesto(o.c.area);
      const v = o.etapa.obterVerificacao();
      assert.equal(v.classe, 'DIVERGENCIA_COMPROVADA');
      assert.equal(v.verificacao.concluida, true);
      assert.equal(v.verificacao.ok, false);
      assert.deepEqual(v.verificacao.divergencias.map((d) => ({ ...d })), [{ chave: chaveAlterada, codigo }]);
      assert.equal(profundamenteCongelado(v), true);
      semVazamento(r);
      semVazamento(v);
    });
  }

  teste('VF-04B — VERIFICAÇÃO INCONCLUSIVA (LEITURA_FALHOU e ENTRADA_INVALIDA do contrato, e exceção síncrona/rejeição assíncrona): nunca sucesso, sem manifesto, sem selagem, sem repetir a cópia; classe INCONCLUSIVA com o diagnóstico original (ou null se o verificador lançou); NUNCA divergência não comprovada (código COPIA_FALHOU, não INTEGRIDADE_DIVERGENTE)', async () => {
    const casos = [
      ['LEITURA_FALHOU', async () => ({ concluida: false, ok: false, motivo: 'LEITURA_FALHOU' }), { concluida: false, ok: false, motivo: 'LEITURA_FALHOU' }],
      ['ENTRADA_INVALIDA', async () => ({ concluida: false, ok: false, motivo: 'ENTRADA_INVALIDA' }), { concluida: false, ok: false, motivo: 'ENTRADA_INVALIDA' }],
      ['exceção síncrona', () => { throw new TypeError(`${SEGREDO} /Users/privado`); }, null],
      ['rejeição assíncrona', async () => { throw new TypeError(`${SEGREDO} /Users/privado`); }, null],
    ];
    for (const [rotulo, substituto, diagnostico] of casos) {
      const o = await operacao({ substituto });
      const r = await o.compor();
      assert.deepEqual({ ok: r.ok, selado: r.selado, ...r.falha }, { ok: false, selado: false, estagio: 'COPIA', codigo: 'COPIA_FALHOU' }, rotulo);
      assert.deepEqual(o.contagem, { copiar: 1, fisica: 1, selar: 0 }, rotulo);
      semManifesto(o.c.area);
      const v = o.etapa.obterVerificacao();
      assert.equal(v.classe, 'INCONCLUSIVA', rotulo);
      assert.deepEqual(v.verificacao === null ? null : { ...v.verificacao }, diagnostico, rotulo);
      assert.equal(Object.hasOwn(v, 'divergencias'), false);
      semVazamento(r);
      semVazamento(v);
    }
  });

  teste('VF-04B2 — INCONCLUSIVA REAL: o verificador físico REAL apontado para um armazenamento cuja leitura falha devolve concluida:false/LEITURA_FALHOU e o diagnóstico é preservado como INCONCLUSIVA, sem declarar divergência', async () => {
    const o = await operacao({
      substituto: async (entrada) => {
        const quebrado = { async abrir() { throw new TypeError(`${SEGREDO} /Users/privado`); } };
        return criarVerificadorDeImagensCopiadas({ destino: quebrado }).verificar(entrada);
      },
    });
    const r = await o.compor();
    assert.deepEqual({ ...r.falha }, { estagio: 'COPIA', codigo: 'COPIA_FALHOU' });
    const v = o.etapa.obterVerificacao();
    assert.equal(v.classe, 'INCONCLUSIVA');
    assert.deepEqual({ ...v.verificacao }, { concluida: false, ok: false, motivo: 'LEITURA_FALHOU' });
    semManifesto(o.c.area);
  });

  const hostil = () => { const h = {}; Object.defineProperty(h, 'ok', { get() { throw new TypeError(`${SEGREDO} /Users/privado`); }, enumerable: true }); return h; };
  const instrumentacaoDoProxy = { consultasThen: 0, acessosHostis: 0, propriedades: [] };
  const invalidos = [
    ['undefined', async () => undefined], ['null', async () => null], ['texto', async () => 'ok'], ['objeto vazio (truthy)', async () => ({})], ['ok:true isolado', async () => ({ ok: true })],
    ['concluida/ok sem examinados e bytes', async () => ({ concluida: true, ok: true })],
    ['ok:true com `divergencias` (contraditório)', async () => ({ concluida: true, ok: true, examinados: 8, bytes: 10, divergencias: [] })],
    ['ok:true com examinados diferente do plano', async () => ({ concluida: true, ok: true, examinados: 7, bytes: 10 })],
    ['concluida:false com ok:true', async () => ({ concluida: false, ok: true, motivo: 'LEITURA_FALHOU' })],
    ['concluida:true, ok:false sem divergências', async () => ({ concluida: true, ok: false, examinados: 1 })],
    ['concluida:true, ok:false com divergências vazias', async () => ({ concluida: true, ok: false, examinados: 1, divergencias: [] })],
    ['divergência com código inventado', async () => ({ concluida: true, ok: false, examinados: 1, divergencias: [{ chave: `7/${H('c')}/mestre.png`, codigo: 'INVENTADO' }] })],
    ['divergência com chave fora do plano', async () => ({ concluida: true, ok: false, examinados: 1, divergencias: [{ chave: `9/${H('1')}/mestre.png`, codigo: 'SHA256_DIVERGENTE' }] })],
    ['motivo inconclusivo inventado', async () => ({ concluida: false, ok: false, motivo: 'OUTRO' })],
    ['inconclusivo com campos extras', async () => ({ concluida: false, ok: false, motivo: 'LEITURA_FALHOU', examinados: 3 })],
    ['getter que lança', async () => hostil()],
    // O alvo do Proxy tem as quatro chaves do retorno POSITIVO: o classificador chega à leitura das propriedades (e não rejeita só por `ownKeys`); `then` é tratado à parte para que a Promise resolva COM o Proxy.
    ['Proxy cujo get lança', async () => {
      instrumentacaoDoProxy.consultasThen = 0;
      instrumentacaoDoProxy.acessosHostis = 0;
      instrumentacaoDoProxy.propriedades.length = 0;
      return new Proxy({ bytes: 0, concluida: true, examinados: 0, ok: true }, {
        get(_alvo, propriedade) {
          if (propriedade === 'then') { instrumentacaoDoProxy.consultasThen += 1; return undefined; }
          instrumentacaoDoProxy.acessosHostis += 1;
          instrumentacaoDoProxy.propriedades.push(String(propriedade));
          throw new TypeError(SEGREDO);
        },
      });
    }, () => {
      assert.ok(instrumentacaoDoProxy.consultasThen >= 1, 'a Promise consultou `then` (assimilação), registrado à parte');
      assert.ok(instrumentacaoDoProxy.acessosHostis >= 1, 'o classificador acessou uma propriedade hostil (diferente de `then`)');
      assert.equal(instrumentacaoDoProxy.propriedades[0], 'bytes', 'primeira leitura do classificador no ramo do retorno positivo');
      assert.ok(instrumentacaoDoProxy.propriedades.every((p) => ['bytes', 'concluida', 'examinados', 'ok'].includes(p)));
    }],
  ];
  for (const [rotulo, substituto, conferirInstrumentacao] of invalidos) {
    teste(`VF-04C (${rotulo}) — RETORNO_INVALIDO: comportamento conservador; nunca verificação concluída; sem manifesto e sem selagem; sem reclassificar como divergência nem como leitura inconclusiva`, async () => {
      const o = await operacao({ substituto });
      const r = await o.compor();
      assert.deepEqual({ ok: r.ok, selado: r.selado, ...r.falha }, { ok: false, selado: false, estagio: 'COPIA', codigo: 'COPIA_FALHOU' });
      assert.deepEqual(o.contagem, { copiar: 1, fisica: 1, selar: 0 });
      semManifesto(o.c.area);
      assert.deepEqual({ ...o.etapa.obterVerificacao() }, { classe: 'RETORNO_INVALIDO' });
      semVazamento(r);
      if (conferirInstrumentacao) conferirInstrumentacao();
    });
  }
});

// ------------------------------------------------------------------------------------------------------------------------------- VF-05
describe('[VF-05] o resultado definitivo pertence à operação e nunca é positivo antes da hora', () => {
  teste('VF-05 — `obterVerificacao()` é null antes de qualquer chamada, null durante a pendência, nunca positivo depois de falha; duas operações guardam resultados INDEPENDENTES (A íntegra, B divergente); a consulta não chama o verificador', async () => {
    const a = await operacao();
    assert.equal(a.etapa.obterVerificacao(), null, 'antes de qualquer chamada');
    const b = await operacao({ alterarDepoisDaCopia: async (c) => fs.rmSync(c.fisico(c.plano[0].chave)) });
    await Promise.all([a.compor(), b.compor()]);
    assert.equal(a.etapa.obterVerificacao().classe, 'INTEGRA');
    assert.equal(b.etapa.obterVerificacao().classe, 'DIVERGENCIA_COMPROVADA');
    assert.notEqual(a.etapa.obterVerificacao(), b.etapa.obterVerificacao());
    for (let i = 0; i < 3; i += 1) { a.etapa.obterVerificacao(); b.etapa.obterVerificacao(); }
    assert.equal(a.contagem.fisica, 1);
    assert.equal(b.contagem.fisica, 1);
    assert.equal(b.etapa.obterVerificacao().classe === 'INTEGRA', false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- VF-06 / VF-07
describe('[VF-06 / VF-07] uma execução por instância; concorrência e pendência', () => {
  teste('VF-06a — CHAMADAS SIMULTÂNEAS: a reserva é síncrona (a cópia já foi chamada UMA vez quando as duas chamadas retornam suas promessas, antes de qualquer await); a segunda recebe a falha genérica COPIA_FALHOU sem executar nada; um único resultado positivo', async () => {
    const c = await cenario();
    let copias = 0;
    let verificacoes = 0;
    const real = criarVerificadorDeImagensCopiadas({ destino: c.destino });
    const etapa = modulo().criarEtapaDeCopiaVerificada({
      copiar: async (contexto) => { copias += 1; return c.copiarReal(contexto); },
      verificador: { verificar: async (e) => { verificacoes += 1; return real.verificar(e); } },
    });
    const p1 = etapa.copiarVerificado(c.contexto);
    const p2 = etapa.copiarVerificado(c.contexto);
    assert.equal(copias, 1, 'a reserva aconteceu antes do primeiro await');
    const [r1, r2] = await Promise.all([p1, p2]);
    assert.equal(r1.ok, true);
    assert.deepEqual(clone(r2), clone(FALHA_GENERICA));
    assert.equal(copias, 1);
    assert.equal(verificacoes, 1);
    assert.equal(etapa.obterVerificacao().classe, 'INTEGRA', 'a chamada recusada não altera o resultado definitivo');
  });

  teste('VF-06b — SEQUENCIAL: depois do sucesso e depois de uma falha, nova chamada é recusada (COPIA_FALHOU) sem repetir cópia nem verificação; nenhum reinício automático; instâncias independentes têm estados independentes', async () => {
    const c = await cenario();
    let copias = 0;
    let verificacoes = 0;
    const real = criarVerificadorDeImagensCopiadas({ destino: c.destino });
    const novaEtapa = (substituto) => modulo().criarEtapaDeCopiaVerificada({
      copiar: async (contexto) => { copias += 1; return c.copiarReal(contexto); },
      verificador: { verificar: async (e) => { verificacoes += 1; return substituto ? substituto() : real.verificar(e); } },
    });
    const comFalha = novaEtapa(async () => ({ concluida: false, ok: false, motivo: 'LEITURA_FALHOU' }));
    const primeira = await comFalha.copiarVerificado(c.contexto);
    assert.equal(primeira.falha.codigo, 'COPIA_FALHOU');
    const classeAntes = comFalha.obterVerificacao();
    for (let i = 0; i < 2; i += 1) assert.deepEqual(clone(await comFalha.copiarVerificado(c.contexto)), clone(FALHA_GENERICA));
    assert.equal(copias, 1);
    assert.equal(verificacoes, 1);
    assert.equal(comFalha.obterVerificacao(), classeAntes);

    const c2 = await cenario();
    const sucesso = modulo().criarEtapaDeCopiaVerificada({ copiar: c2.copiarReal, verificador: criarVerificadorDeImagensCopiadas({ destino: c2.destino }) });
    assert.equal((await sucesso.copiarVerificado(c2.contexto)).ok, true);
    assert.deepEqual(clone(await sucesso.copiarVerificado(c2.contexto)), clone(FALHA_GENERICA));
    assert.equal(sucesso.obterVerificacao().classe, 'INTEGRA');
    assert.equal(comFalha.obterVerificacao().classe, 'INCONCLUSIVA', 'a outra instância não foi afetada');
  });

  teste('VF-07 — PENDENTE (barreira controlada pelo teste dentro da verificação): enquanto pendente, a composição não avança ao manifesto, a selagem não começa, `obterVerificacao()` é null, uma segunda chamada da etapa NÃO reinicia a cópia; liberada a barreira, tudo conclui deterministicamente', async () => {
    let liberar;
    let verificacaoComecou;
    const comecou = new Promise((res) => { verificacaoComecou = res; });
    const barreira = new Promise((res) => { liberar = res; });
    const o = await operacao({ substituto: async (entrada, real) => { verificacaoComecou(); await barreira; return real.verificar(entrada); } });
    let composicaoLiquidou = false;
    const composicao = o.compor().then((r) => { composicaoLiquidou = true; return r; });
    await comecou;
    assert.equal(composicaoLiquidou, false);
    assert.equal(o.etapa.obterVerificacao(), null, 'nenhuma avaliação positiva disponível durante a pendência');
    assert.deepEqual(o.contagem, { copiar: 1, fisica: 1, selar: 0 });
    assert.deepEqual(clone(await o.etapa.copiarVerificado(o.c.contexto)), clone(FALHA_GENERICA));
    assert.equal(o.contagem.copiar, 1, 'a segunda chamada não reiniciou a cópia');
    semManifesto(o.c.area);
    liberar();
    const r = await composicao;
    assert.equal(r.ok, true);
    assert.equal(o.etapa.obterVerificacao().classe, 'INTEGRA');
    assert.deepEqual(o.contagem, { copiar: 1, fisica: 1, selar: 1 });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- VF-08 e interface
describe('[VF-08] identidade, contexto e interface', () => {
  teste('VF-08a — ASSOCIAÇÃO: o verificador recebe exatamente o `plano` do contexto e o resultado ORIGINAL da cópia; empresas 7 e 8 com o MESMO diretório de hash não se misturam (troca de arquivos entre elas depois da cópia é divergência por conteúdo, não aprovada pelo diretório)', async () => {
    const o = await operacao({
      alterarDepoisDaCopia: async (c) => {
        const m7 = chaveDe(c, (k) => k.startsWith('7/') && k.endsWith('miniatura.webp'));
        const m8 = chaveDe(c, (k) => k.startsWith('8/') && k.endsWith('miniatura.webp'));
        const b7 = fs.readFileSync(c.fisico(m7));
        const b8 = fs.readFileSync(c.fisico(m8));
        fs.writeFileSync(c.fisico(m7), b8);
        fs.writeFileSync(c.fisico(m8), b7);
      },
    });
    const r = await o.compor();
    assert.equal(r.ok, false);
    assert.equal(o.argumentosDaFisica[0].plano, o.c.contexto.plano);
    assert.equal(o.argumentosDaFisica[0].copia, o.resultadosDaCopia[0]);
    const v = o.etapa.obterVerificacao();
    assert.equal(v.classe, 'DIVERGENCIA_COMPROVADA');
    const chaves = v.verificacao.divergencias.map((d) => d.chave).sort();
    assert.deepEqual(chaves, o.c.plano.filter((p) => p.chave.endsWith('miniatura.webp') && (p.chave.startsWith('7/') || p.chave.startsWith('8/'))).map((p) => p.chave).sort());
    assert.equal(o.contagem.selar, 0);
  });

  teste('VF-08b — a criação é ESTRITA: chaves desconhecidas (como `area` ou `destino`), `copiar` que não é função, verificador sem `verificar` e métodos capturados UMA vez (trocá-los depois não muda nada); a interface expõe só { copiarVerificado, obterVerificacao } e nenhum meio de selar, publicar, limpar, liberar trava ou finalizar snapshot', async () => {
    const { criarEtapaDeCopiaVerificada } = modulo();
    const ok = { copiar: async () => FALHA_GENERICA, verificador: { verificar: async () => ({}) } };
    for (const ruim of [null, 'x', [], {}, { copiar: ok.copiar }, { ...ok, area: '/tmp' }, { ...ok, destino: {} }, { ...ok, copiar: 'x' }, { ...ok, verificador: {} }, { ...ok, verificador: { verificar: 'x' } }]) {
      assert.throws(() => criarEtapaDeCopiaVerificada(ruim), TypeError);
    }
    let chamadas = 0;
    const verificador = { verificar: async () => { chamadas += 1; return { concluida: false, ok: false, motivo: 'LEITURA_FALHOU' }; } };
    const etapa = criarEtapaDeCopiaVerificada({ copiar: async () => { const c = await cenario(); return c.copiarReal(c.contexto); }, verificador });
    verificador.verificar = async () => { throw new Error('trocado depois'); };
    assert.deepEqual(Object.keys(etapa).sort(), ['copiarVerificado', 'obterVerificacao']);
    assert.equal(Object.isFrozen(etapa), true);
    for (const nome of ['selar', 'publicar', 'limpar', 'liberar', 'finalizar', 'construirManifesto']) assert.equal(Object.hasOwn(etapa, nome), false, nome);
    const contexto = Object.freeze({ plano: [] });
    await etapa.copiarVerificado(contexto);
    assert.equal(chamadas <= 1, true);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- pendências
describe('[PENDÊNCIAS] riscos e lacunas registrados, NÃO resolvidos por este vínculo', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('VF-09 — o `verificador` precisa estar ligado ao MESMO destino que `copiar` usa; os contratos não carregam essa associação (nem snapshotId/conjuntoId): é responsabilidade da composição confiável que cria a etapa por operação', 'identidade operacional ausente');
  todo('VF-10 — a imagem pode mudar DEPOIS da verificação e ANTES do manifesto/selagem (janela entre etapas): sem imutabilidade, sem trava de escrita em todos os escritores, sem excluir TOCTOU; uma segunda verificação depois da selagem seria outro incremento', 'limite operacional');
  todo('VF-11 — o canal lateral `obterVerificacao()` só é confiável dentro de um adaptador confiável; ligação ao `avaliar` do coordenador (relatório, verificação independente) depende da decisão pendente sobre os elementos do avaliador completo', 'decisão pendente');
  todo('VF-12 — operação pendente indefinidamente (verificação ou cópia que nunca termina) prende a trava e o snapshot; exige cancelamento seguro em cópia e verificador, sem prazo arbitrário', 'incremento próprio');
  todo('VF-13 — integridade física do dump, consistência transacional PostgreSQL x filesystem, autenticidade, publicação atômica, durabilidade e restauração independente: fora do alcance deste vínculo', 'bloqueio operacional');
});
