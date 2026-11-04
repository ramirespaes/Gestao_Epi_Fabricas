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
const { construirManifesto, lerManifesto } = require('../../src/services/imagem-backup-manifesto.service');
const { criarSelagem } = require('../../src/services/imagem-backup-selagem.service');
const { avaliarConjunto, executarBackup } = require('../../src/services/imagem-backup.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-COMPOSICAO-CONJUNTO-1): COMPOSIÇÃO lógica dos quatro componentes já aprovados (plano -> cópia verificada -> manifesto -> selagem). Só dados
 * FICTÍCIOS em diretórios temporários descartáveis do próprio teste (prefixo `gepi-composicao-test-`). Nada aqui toca PostgreSQL, `pg_dump`, processo externo ou imagens reais, e nenhum resultado é, nem
 * pode ser lido como, backup publicado ou recuperável.
 *
 * ACHADOS DA INSPEÇÃO (lidos no código, sem presumir):
 *   - o coordenador (`executarBackup`) usa do retorno de cada etapa APENAS `ok`; `avaliar` recebe somente { etapas: [nomes] } (CTL-01): o resultado da cópia (`arquivos`) e a evidência do dump NÃO chegam à
 *     avaliação por esse caminho. A composição, portanto, precisa fechar sobre esses valores (fechamento do chamador), e NÃO depende de o coordenador transportá-los;
 *   - `executarBackupOperacional` entrega o MESMO `contexto` validado do snapshot (com `plano`) a `processoDoDump(contexto)` e a `copia(contexto)`: é por aí que o plano chega à composição;
 *   - NADA no projeto produz a evidência do dump `{ concluido, bytes, sha256Declarado, sha256Recalculado }` (só o `avaliarConjunto` a lê). Nestes testes ela é FICTÍCIA (`DUMP_FICTICIO`) e não representa
 *     nenhum dump PostgreSQL. Um produtor real e independente do `sha256Recalculado` continua pendente;
 *   - a identidade esperada chega à selagem pela própria composição: ela constrói o manifesto, obtém `identidade` e a passa como `esperado` a `verificar`;
 *   - os componentes já se encadeiam manualmente hoje (CTL-02/03), então a composição é fina.
 *
 * INTERFACE MÍNIMA PROPOSTA (provisória; nada em produção): src/services/imagem-backup-composicao.service.js exporta
 *   `criarComposicaoDoConjunto({ copiar, selagem, area, conjuntoId })` (ESTRITO; lança TypeError se inválido) -> { compor({ contexto, dump }) };
 *   - `copiar` = o `copia(contexto)` do módulo de cópia; `selagem` = { selar, verificar } (a de `criarSelagem`); `area` e `conjuntoId` são fixados NA CRIAÇÃO por quem compõe (composição confiável): NUNCA por
 *     chamada, então uma entrada de usuário não escolhe onde se escreve (COM-07). `area` inválida (relativa, `..`, NUL, não string) lança já na criação, sem tocar o disco; as demais regras da área
 *     continuam sendo da selagem;
 *   - `compor` (ESTRITO: só `contexto` e `dump`) executa NESTA ordem e PARA na primeira falha: (1) `copiar(contexto)`; (2) `construirManifesto({ contexto, copia, dump, conjuntoId })` (não duplica nenhuma
 *     regra de validação: plano, cópia, dump, banco e identidade são do manifesto); (3) `selagem.selar({ area, resultado })`; (4) `selagem.verificar({ area, esperado: identidade })` e confere que a
 *     identidade verificada é a esperada (não confia cegamente na selagem);
 *   - sucesso: { ok: true, selado: true, arquivos: <quantidade do plano>, identidade, manifesto } (congelado); falha: { ok: false, selado: false, falha: { estagio, codigo } } com estagio em ENTRADA | COPIA |
 *     MANIFESTO | SELAGEM | VERIFICACAO e códigos de um conjunto FIXO (códigos desconhecidos viram o genérico do estágio), sem caminho, mensagem de dependência ou valor recebido;
 *   - a composição NÃO remove nada (nem artefatos parciais): a limpeza é da selagem e só do que ela criou; arquivos já copiados para o destino ficam e a falha informa que o conjunto NÃO está selado.
 *   - Nenhum resultado tem `recuperavel`, `provaDeRestauracao`, `publicado` ou equivalente.
 *
 * NÃO RESOLVIDO (bloqueios explícitos, TODO no fim): ligação às etapas de `executarBackupOperacional`, produtor real da evidência do dump, TOCTOU, contenção de processos, publicação atômica do conjunto,
 * trava de escrita em todos os escritores, durabilidade real e restauração independente.
 *
 * COMO LER: o módulo NÃO existe; as falhas por "módulo ausente" NÃO são provas comportamentais independentes. Os CTL-* passam hoje e fixam como os componentes reais já se encaixam.
 */

const MODULO = 'src/services/imagem-backup-composicao.service';
const composicaoModulo = () => exigirModulo(MODULO);
const PRAZO = 30000;
const PREFIXO = 'gepi-composicao-test-';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const teste = (nome, fn) => test(nome, { timeout: PRAZO }, fn);
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const MANIFESTO = 'manifesto.json';
const HASH = 'manifesto.sha256';
const CONJUNTO = 'conjunto-com-0001';
/** EVIDÊNCIA FICTÍCIA DE DUMP: não existe dump PostgreSQL aqui. */
const DUMP_FICTICIO = Object.freeze({ concluido: true, bytes: 1234, sha256Declarado: H('7'), sha256Recalculado: H('7') });

// ------------------------------------------------------------------------------------------------------------------------------- áreas e dados fictícios
const criadas = [];
function pasta() {
  const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO)));
  fs.chmodSync(p, 0o700);
  criadas.push(p);
  return p;
}
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of criadas) if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO)) fs.rmSync(p, { recursive: true, force: true });
});
const listar = (p) => fs.readdirSync(p).sort();

/** Registros no formato do snapshot: 1 imagem padrão (sem exibição) e DUAS empresas com o MESMO diretório de hash e conteúdos diferentes. */
function registrosFicticios() {
  const buf = (texto) => Buffer.from(texto, 'utf8');
  const padraoMestre = buf('padrao-mestre');
  const padraoMiniatura = buf('padrao-miniatura');
  const linhaEmpresa = (id, empresaId) => ({
    id: String(id), empresaId, sha256: H('c'), formato: 'PNG',
    sha256Mestre: sha(buf(`m-${empresaId}`)), sha256Exibicao: sha(buf(`e-${empresaId}`)), sha256Miniatura: sha(buf(`mi-${empresaId}`)),
    bytesMestre: buf(`m-${empresaId}`).length, bytesExibicao: buf(`e-${empresaId}`).length, bytesMiniatura: buf(`mi-${empresaId}`).length,
  });
  const conteudos = [padraoMestre, padraoMiniatura, ...[7, 8].flatMap((e) => [buf(`m-${e}`), buf(`e-${e}`), buf(`mi-${e}`)])];
  const registros = {
    padrao: [{ id: '1', sha256: sha(padraoMestre), sha256Miniatura: sha(padraoMiniatura), sha256Exibicao: null, formato: 'PNG', bytesMestre: padraoMestre.length, bytesMiniatura: padraoMiniatura.length, bytesExibicao: null }],
    empresa: [linhaEmpresa(1, 7), linhaEmpresa(2, 8)],
  };
  return { registros, conteudos };
}

/** Cenário completo: origem semeada, destino de cópia e área de selagem, tudo em diretórios descartáveis. `omitir` = índice do plano que NÃO é semeado na origem. */
async function cenario({ omitir = null } = {}) {
  const raiz = pasta();
  const { registros, conteudos } = registrosFicticios();
  const plano = planejarArquivos(registros);
  assert.equal(plano.length, 8);
  const origem = criarArmazenamentoImagens({ diretorio: path.join(raiz, 'origem') });
  const destino = criarArmazenamentoImagens({ diretorio: path.join(raiz, 'preparacao', 'imagens') });
  for (let i = 0; i < plano.length; i += 1) {
    if (i === omitir) continue;
    const bytes = conteudos.find((c) => sha(c) === plano[i].sha256);
    await origem.gravar(plano[i].chave, bytes, { maxBytes: 4096, sha256Esperado: plano[i].sha256 });
  }
  const area = path.join(raiz, 'preparacao');
  const contexto = Object.freeze({ snapshotId: '0-0-0', banco: Object.freeze({ nome: 'gestao_epi', oid: '16384' }), registros, plano });
  const copiar = criarCopiaDeImagens({ origem, destino, maxBytesPorArquivo: 4096 });
  return { raiz, area, contexto, plano, destino, origem, copiar };
}

/** Selagem real com registro de chamadas e ganchos opcionais. */
function selagemObservada(eventos, { antesDeSelar, aoSelar, aoVerificar } = {}) {
  const real = criarSelagem();
  return {
    selar: async (e) => { eventos.push('selar'); if (antesDeSelar) antesDeSelar(e); return aoSelar ? aoSelar(real, e) : real.selar(e); },
    verificar: async (e) => { eventos.push('verificar'); return aoVerificar ? aoVerificar(real, e) : real.verificar(e); },
  };
}
const copiarObservada = (copiar, eventos) => async (contexto) => { eventos.push('copiar:inicio'); const r = await copiar(contexto); eventos.push('copiar:fim'); return r; };
const compor = (c, { copiar, selagem = criarSelagem(), conjuntoId = CONJUNTO, dump = DUMP_FICTICIO, area = c.area } = {}) =>
  composicaoModulo().criarComposicaoDoConjunto({ copiar: copiar ?? c.copiar, selagem, area, conjuntoId }).compor({ contexto: c.contexto, dump });

const semAfirmacoes = (valor) => {
  const texto = JSON.stringify(valor).toLowerCase();
  for (const proibida of ['recuper', 'prova', 'restaur', 'publicad']) assert.equal(texto.includes(proibida), false, proibida);
};
const semVazamento = (valor) => {
  const texto = JSON.stringify(valor);
  for (const proibido of [SEGREDO, '/Users/privado', os.tmpdir(), PREFIXO]) assert.equal(texto.includes(proibido), false, proibido);
};
const falhaEsperada = (r, estagio, codigo) => {
  assert.equal(r.ok, false);
  assert.equal(r.selado, false);
  assert.deepEqual({ ...r.falha }, { estagio, codigo });
  for (const proibida of ['identidade', 'manifesto', 'arquivos']) assert.equal(Object.hasOwn(r, proibida), false, proibida);
  semAfirmacoes(r);
  semVazamento(r);
};
const semArtefatos = (area) => assert.equal(fs.readdirSync(area).some((n) => n.startsWith('manifesto.')), false, 'nenhum manifesto.* na área');
const clone = (v) => JSON.parse(JSON.stringify(v));

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: como os componentes reais já se encaixam', () => {
  teste('CTL-01 — o coordenador real descarta o retorno das etapas (usa só `ok`) e entrega a `avaliar` APENAS os nomes das etapas: o resultado da cópia não chega à avaliação; por isso a composição fecha sobre os valores', async () => {
    let recebido;
    const etapa = (nome) => ({ nome, executar: async () => ({ ok: true, arquivos: [{ chave: 'x' }], segredo: SEGREDO }) });
    const janela = { adquirir: async () => ({ confirmarPosse: async () => ({ confirmada: true }), liberar: async () => ({ liberada: true }) }) };
    await executarBackup({ janela, etapas: ['snapshot', 'dump', 'copia'].map(etapa), avaliar: async (entrada) => { recebido = entrada; return { valido: false }; } });
    assert.deepEqual(JSON.parse(JSON.stringify(recebido)), { etapas: ['snapshot', 'dump', 'copia'] });
    assert.equal(JSON.stringify(recebido).includes('arquivos'), false);
  });

  teste('CTL-02 — encadeamento MANUAL com os módulos reais: plano -> cópia verificada -> manifesto -> selagem -> verificação com a identidade esperada (sem módulo de composição)', async () => {
    const c = await cenario();
    const copia = await c.copiar(c.contexto);
    assert.equal(copia.ok, true);
    const r = construirManifesto({ contexto: c.contexto, copia, dump: { ...DUMP_FICTICIO }, conjuntoId: CONJUNTO });
    const selagem = criarSelagem();
    assert.equal((await selagem.selar({ area: c.area, resultado: r })).ok, true);
    const v = await selagem.verificar({ area: c.area, esperado: { ...r.identidade } });
    assert.equal(v.ok, true);
    assert.deepEqual(v.manifesto.arquivos.map((a) => a.chave), c.plano.map((p) => p.chave));
    for (const item of c.plano) assert.equal(await c.destino.existe(item.chave), true);
  });

  teste('CTL-03 — o `avaliarConjunto` real aceita o manifesto e a identidade desse encadeamento (valido), e continua sem declarar recuperável sem prova de restauração', async () => {
    const c = await cenario();
    const copia = await c.copiar(c.contexto);
    const r = construirManifesto({ contexto: c.contexto, copia, dump: { ...DUMP_FICTICIO }, conjuntoId: CONJUNTO });
    const avaliacao = avaliarConjunto({
      saidaDoProcedimento: 0, relatorio: { veredito: 'VALIDO' }, manifesto: r.manifesto, listaDoSnapshot: c.plano, verificacao: { concluida: true, ok: true }, dump: { ...DUMP_FICTICIO }, identidade: { ...r.identidade },
    });
    assert.equal(avaliacao.valido, true);
    assert.equal(avaliacao.recuperavel, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COM-01
describe('[COM-01] fluxo completo simulado (dados fictícios; NÃO é backup PostgreSQL real)', () => {
  teste('COM-01 — plano, cópia, manifesto, selagem e releitura: resultado positivo com identidade; os artefatos em disco são verificáveis de forma independente; as duas empresas com o mesmo diretório de hash ficam em chaves distintas', async () => {
    const c = await cenario();
    const r = await compor(c);
    assert.deepEqual(Object.keys(r).sort(), ['arquivos', 'identidade', 'manifesto', 'ok', 'selado']);
    assert.equal(r.ok, true);
    assert.equal(r.selado, true);
    assert.equal(r.arquivos, 8);
    assert.equal(r.identidade.conjuntoId, CONJUNTO);
    assert.equal(Object.isFrozen(r), true);
    // verificação independente, fora da composição
    const v = await criarSelagem().verificar({ area: c.area, esperado: { ...r.identidade } });
    assert.equal(v.ok, true);
    assert.equal(v.sha256, r.identidade.sha256Manifesto);
    assert.equal(sha(fs.readFileSync(path.join(c.area, MANIFESTO))), r.identidade.sha256Manifesto);
    assert.deepEqual(v.manifesto.arquivos.map((a) => a.chave), c.plano.map((p) => p.chave));
    assert.equal(c.plano.some((p) => p.chave.startsWith('7/')) && c.plano.some((p) => p.chave.startsWith('8/')), true);
    for (const item of v.manifesto.arquivos) {
      assert.equal(await c.destino.existe(item.chave), true);
      const lido = []; for await (const b of await c.destino.abrir(item.chave)) lido.push(b);
      assert.equal(sha(Buffer.concat(lido)), item.sha256);
    }
    assert.deepEqual(listar(c.area).filter((n) => n.startsWith('manifesto.')), [MANIFESTO, HASH]);
    semAfirmacoes(r);
  });

  teste('COM-01b — a evidência do dump FICTÍCIA é só registrada no manifesto (nada é recalculado nem afirmado sobre o dump) e o `avaliarConjunto` real aceita o resultado da composição, sem recuperável', async () => {
    const c = await cenario();
    const r = await compor(c);
    assert.deepEqual({ ...r.manifesto.dump }, { bytes: DUMP_FICTICIO.bytes, sha256: DUMP_FICTICIO.sha256Recalculado });
    const avaliacao = avaliarConjunto({
      saidaDoProcedimento: 0, relatorio: { veredito: 'VALIDO' }, manifesto: r.manifesto, listaDoSnapshot: c.plano, verificacao: { concluida: true, ok: true }, dump: { ...DUMP_FICTICIO }, identidade: { ...r.identidade },
    });
    assert.equal(avaliacao.valido, true);
    assert.equal(avaliacao.recuperavel, false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COM-02
describe('[COM-02] ordem obrigatória', () => {
  teste('COM-02 — copiar (início e fim) -> selar -> verificar, nesta ordem; no instante de `selar` a cópia já terminou e a área ainda NÃO tem nenhum `manifesto.*`', async () => {
    const c = await cenario();
    const eventos = [];
    let areaAntes;
    const r = await compor(c, {
      copiar: copiarObservada(c.copiar, eventos),
      selagem: selagemObservada(eventos, { antesDeSelar: () => { areaAntes = listar(c.area).filter((n) => n.startsWith('manifesto.')); } }),
    });
    assert.equal(r.ok, true);
    assert.deepEqual(eventos, ['copiar:inicio', 'copiar:fim', 'selar', 'verificar']);
    assert.deepEqual(areaAntes, []);
  });

  teste('COM-02b — `verificar` só roda DEPOIS de uma selagem bem-sucedida e recebe como `esperado` exatamente a identidade construída (conjuntoId + SHA-256), nunca o SHA-256 isolado', async () => {
    const c = await cenario();
    let esperadoRecebido;
    const eventos = [];
    const r = await compor(c, { selagem: selagemObservada(eventos, { aoVerificar: (real, e) => { esperadoRecebido = e.esperado; return real.verificar(e); } }) });
    assert.deepEqual({ ...esperadoRecebido }, { ...r.identidade });
    assert.deepEqual(Object.keys(esperadoRecebido).sort(), ['conjuntoId', 'sha256Manifesto']);
    // selagem que falha: `verificar` nunca roda
    const c2 = await cenario();
    fs.writeFileSync(path.join(c2.area, MANIFESTO), 'ALHEIO');
    const eventos2 = [];
    const r2 = await compor(c2, { selagem: selagemObservada(eventos2) });
    falhaEsperada(r2, 'SELAGEM', 'DESTINO_EXISTENTE');
    assert.deepEqual(eventos2, ['selar']);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COM-03
describe('[COM-03] cópia incompleta nunca vira conjunto selado', () => {
  teste('COM-03a — origem sem um dos arquivos (cópia REAL falha): estágio COPIA/ORIGEM_AUSENTE; nem manifesto nem selagem; os arquivos já copiados NÃO são apagados pela composição', async () => {
    const c = await cenario({ omitir: 7 });
    const eventos = [];
    const r = await compor(c, { copiar: copiarObservada(c.copiar, eventos), selagem: selagemObservada(eventos) });
    falhaEsperada(r, 'COPIA', 'ORIGEM_AUSENTE');
    assert.deepEqual(eventos, ['copiar:inicio', 'copiar:fim']);
    semArtefatos(c.area);
    for (const item of c.plano.slice(0, 7)) assert.equal(await c.destino.existe(item.chave), true, 'cópia parcial preservada, sem limpeza destrutiva');
  });

  const copiaRuim = [
    ['`ok:false` com código desconhecido e mensagem hostil', async () => ({ ok: false, completo: false, arquivos: [], copiados: 0, falha: { codigo: SEGREDO, chave: '/Users/privado' } }), 'COPIA_FALHOU'],
    ['`copiar` lança exceção hostil', async () => { throw new TypeError(`${SEGREDO} /Users/privado`); }, 'COPIA_FALHOU'],
    ['`copiar` devolve algo que não é objeto', async () => 'ok', 'COPIA_FALHOU'],
    ['`copiar` devolve undefined', async () => undefined, 'COPIA_FALHOU'],
  ];
  for (const [rotulo, copiar, codigo] of copiaRuim) {
    teste(`COM-03b (${rotulo}) — COPIA/${codigo}, sem eco, sem manifesto e sem selagem`, async () => {
      const c = await cenario();
      const eventos = [];
      const r = await compor(c, { copiar: async (ctx) => { eventos.push('copiar'); return copiar(ctx); }, selagem: selagemObservada(eventos) });
      falhaEsperada(r, 'COPIA', codigo);
      assert.deepEqual(eventos, ['copiar']);
      semArtefatos(c.area);
    });
  }

  teste('COM-03c — os códigos conhecidos da cópia real são repassados (estágio COPIA), por exemplo DESTINO_EXISTENTE quando o destino já tem a chave', async () => {
    const c = await cenario();
    await c.destino.gravar(c.plano[0].chave, Buffer.from('x'), { maxBytes: 10 });
    const r = await compor(c);
    assert.equal(r.ok, false);
    assert.equal(r.falha.estagio, 'COPIA');
    assert.ok(['DESTINO_EXISTENTE', 'INTEGRIDADE_DIVERGENTE'].includes(r.falha.codigo));
    semArtefatos(c.area);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COM-04
describe('[COM-04] inconsistência entre plano, cópia e manifesto impede a selagem', () => {
  const adulterar = [
    ['arquivo FALTANDO na cópia', (r) => ({ ...r, arquivos: r.arquivos.slice(1), copiados: r.arquivos.length - 1 })],
    ['arquivo A MAIS fora do plano', (r) => ({ ...r, arquivos: [...r.arquivos, { chave: `9/${H('1')}/mestre.png`, sha256: H('2'), bytes: 4 }], copiados: r.arquivos.length + 1 })],
    ['arquivo REPETIDO', (r) => ({ ...r, arquivos: [...r.arquivos, r.arquivos[0]], copiados: r.arquivos.length + 1 })],
    ['hash DIVERGENTE do plano', (r) => ({ ...r, arquivos: r.arquivos.map((a, i) => (i === 0 ? { ...a, sha256: H('0') } : a)) })],
    ['`bytes` zero', (r) => ({ ...r, arquivos: r.arquivos.map((a, i) => (i === 0 ? { ...a, bytes: 0 } : a)) })],
    ['MISTURA de empresas: chave da empresa 8 com o hash da empresa 7', (r) => ({ ...r, arquivos: r.arquivos.map((a) => (a.chave.startsWith('7/') && a.chave.endsWith('mestre.png') ? { ...a, chave: a.chave.replace('7/', '8/') } : a)) })],
    ['`falha` presente apesar de `ok`', (r) => ({ ...r, falha: { codigo: 'COPIA_FALHOU', chave: null } })],
    ['campo extra de recuperabilidade no resultado da cópia', (r) => ({ ...r, recuperavel: true })],
  ];
  for (const [rotulo, alterar] of adulterar) {
    teste(`COM-04 (${rotulo}) — MANIFESTO/MANIFESTO_INVALIDO; \`selar\` nunca é chamado e a área fica sem \`manifesto.*\``, async () => {
      const c = await cenario();
      const real = await c.copiar(c.contexto);
      const eventos = [];
      const r = await compor(c, { copiar: async () => alterar(clone(real)), selagem: selagemObservada(eventos) });
      falhaEsperada(r, 'MANIFESTO', 'MANIFESTO_INVALIDO');
      assert.deepEqual(eventos, []);
      semArtefatos(c.area);
    });
  }

  const dumpsRuins = [['dump não concluído', { ...DUMP_FICTICIO, concluido: false }], ['hashes do dump divergentes', { ...DUMP_FICTICIO, sha256Recalculado: H('8') }], ['dump sem bytes', { ...DUMP_FICTICIO, bytes: 0 }]];
  for (const [rotulo, dump] of dumpsRuins) {
    teste(`COM-04b (${rotulo}) — MANIFESTO/MANIFESTO_INVALIDO sem selagem: a regra do dump é do manifesto, não duplicada aqui`, async () => {
      const c = await cenario();
      const eventos = [];
      const r = await compor(c, { dump, selagem: selagemObservada(eventos) });
      falhaEsperada(r, 'MANIFESTO', 'MANIFESTO_INVALIDO');
      assert.deepEqual(eventos, []);
      semArtefatos(c.area);
    });
  }

  teste('COM-04c — `conjuntoId` inválido da composição (vazio, com quebra de linha) é recusado pelo manifesto: MANIFESTO/MANIFESTO_INVALIDO, sem selagem', async () => {
    for (const conjuntoId of ['', 'a\nb']) {
      const c = await cenario();
      const r = await compor(c, { conjuntoId });
      falhaEsperada(r, 'MANIFESTO', 'MANIFESTO_INVALIDO');
      semArtefatos(c.area);
    }
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COM-05
describe('[COM-05] falha na selagem ou na verificação impede o resultado positivo e não destrói nada', () => {
  teste('COM-05a — destino pré-existente (`manifesto.json` alheio): SELAGEM/DESTINO_EXISTENTE; o arquivo alheio fica intacto', async () => {
    const c = await cenario();
    fs.writeFileSync(path.join(c.area, MANIFESTO), 'ALHEIO');
    fs.writeFileSync(path.join(c.area, 'outro.txt'), 'OUTRO');
    const r = await compor(c);
    falhaEsperada(r, 'SELAGEM', 'DESTINO_EXISTENTE');
    assert.equal(fs.readFileSync(path.join(c.area, MANIFESTO), 'utf8'), 'ALHEIO');
    assert.equal(fs.readFileSync(path.join(c.area, 'outro.txt'), 'utf8'), 'OUTRO');
  });

  teste('COM-05b — falha de escrita/sincronização injetada na selagem real: SELAGEM/ESCRITA_FALHOU, sem eco; nenhum `manifesto.*` fica e o arquivo alheio é preservado', async () => {
    const { operacoesDoSistema } = require('../../src/services/imagem-backup-selagem.service');
    const c = await cenario();
    fs.writeFileSync(path.join(c.area, 'outro.txt'), 'OUTRO');
    const base = operacoesDoSistema();
    const selagem = criarSelagem({ operacoes: { ...base, sincronizarDiretorio: async () => { throw new TypeError(`${SEGREDO} /Users/privado`); } } });
    const r = await compor(c, { selagem });
    falhaEsperada(r, 'SELAGEM', 'ESCRITA_FALHOU');
    semArtefatos(c.area);
    assert.equal(fs.readFileSync(path.join(c.area, 'outro.txt'), 'utf8'), 'OUTRO');
  });

  const selagemRuim = [
    ['`selar` lança exceção hostil', { selar: async () => { throw new TypeError(`${SEGREDO} /Users/privado`); } }, 'SELAGEM', 'ESCRITA_FALHOU'],
    ['`selar` devolve ok sem `selado`', { selar: async () => ({ ok: true, selado: false }) }, 'SELAGEM', 'ESCRITA_FALHOU'],
    ['`selar` devolve ok:false com código desconhecido', { selar: async () => ({ ok: false, selado: false, falha: { codigo: SEGREDO } }) }, 'SELAGEM', 'ESCRITA_FALHOU'],
    ['`selar` devolve algo que não é objeto', { selar: async () => null }, 'SELAGEM', 'ESCRITA_FALHOU'],
  ];
  for (const [rotulo, parcial, estagio, codigo] of selagemRuim) {
    teste(`COM-05c (${rotulo}) — ${estagio}/${codigo}, sem resultado positivo e sem \`verificar\``, async () => {
      const c = await cenario();
      const eventos = [];
      const real = criarSelagem();
      const selagem = { selar: async (e) => { eventos.push('selar'); return parcial.selar(e); }, verificar: async (e) => { eventos.push('verificar'); return real.verificar(e); } };
      const r = await compor(c, { selagem });
      falhaEsperada(r, estagio, codigo);
      assert.deepEqual(eventos, ['selar']);
    });
  }

  teste('COM-05d — manifesto adulterado entre a selagem e a releitura: VERIFICACAO/MANIFESTO_INVALIDO, sem resultado positivo; os arquivos NÃO são apagados (evidência preservada)', async () => {
    const c = await cenario();
    const selagem = selagemObservada([], { aoVerificar: (real, e) => { const alvo = path.join(c.area, MANIFESTO); fs.writeFileSync(alvo, fs.readFileSync(alvo).subarray(0, 40)); return real.verificar(e); } });
    const r = await compor(c, { selagem });
    falhaEsperada(r, 'VERIFICACAO', 'MANIFESTO_INVALIDO');
    assert.equal(fs.existsSync(path.join(c.area, MANIFESTO)), true);
    assert.equal(fs.existsSync(path.join(c.area, HASH)), true);
  });

  teste('COM-05e — a composição NÃO confia cegamente na releitura: `verificar` que devolve ok com identidade de OUTRO conjunto dá VERIFICACAO/IDENTIDADE_DIVERGENTE; ok sem identidade também falha', async () => {
    for (const devolvido of [
      (v) => ({ ...v, identidade: { conjuntoId: 'conjunto-outro', sha256Manifesto: v.identidade.sha256Manifesto } }),
      (v) => ({ ...v, identidade: { conjuntoId: v.identidade.conjuntoId, sha256Manifesto: H('0') } }),
      (v) => ({ ok: true, verificado: true }),
    ]) {
      const c = await cenario();
      const selagem = selagemObservada([], { aoVerificar: async (real, e) => devolvido(await real.verificar(e)) });
      const r = await compor(c, { selagem });
      assert.equal(r.ok, false);
      assert.equal(r.falha.estagio, 'VERIFICACAO');
      assert.ok(['IDENTIDADE_DIVERGENTE', 'LEITURA_FALHOU'].includes(r.falha.codigo));
      semAfirmacoes(r);
    }
  });

  teste('COM-05f — `verificar` com falha repassa um código conhecido (VERIFICACAO) ou o genérico LEITURA_FALHOU, nunca a mensagem da dependência', async () => {
    const c = await cenario();
    const selagem = selagemObservada([], { aoVerificar: async () => { throw new TypeError(`${SEGREDO} /Users/privado`); } });
    falhaEsperada(await compor(c, { selagem }), 'VERIFICACAO', 'LEITURA_FALHOU');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COM-06
describe('[COM-06] identidade: sem mistura de operações, conjuntos ou empresas', () => {
  teste('COM-06a — dois conjuntos em áreas distintas têm identidades diferentes e cada um só é aceito com a PRÓPRIA identidade (o SHA-256 isolado não decide)', async () => {
    const a = await cenario();
    const b = await cenario();
    const ra = await compor(a, { conjuntoId: 'conjunto-com-A' });
    const rb = await compor(b, { conjuntoId: 'conjunto-com-B' });
    assert.notEqual(ra.identidade.sha256Manifesto, rb.identidade.sha256Manifesto);
    const selagem = criarSelagem();
    assert.equal((await selagem.verificar({ area: a.area, esperado: { ...ra.identidade } })).ok, true);
    assert.equal((await selagem.verificar({ area: a.area, esperado: { ...rb.identidade } })).falha.codigo, 'IDENTIDADE_DIVERGENTE');
    assert.equal((await selagem.verificar({ area: b.area, esperado: { ...ra.identidade } })).falha.codigo, 'IDENTIDADE_DIVERGENTE');
  });

  teste('COM-06b — mesmos dados e mesmo `conjuntoId` em OUTRA execução produzem o mesmo SHA-256 (determinismo), mas a identidade só vale para a área onde foi selada; reutilizar a mesma área é SELAGEM/DESTINO_EXISTENTE e a primeira selagem segue íntegra', async () => {
    const a = await cenario();
    const r1 = await compor(a);
    const b = await cenario();
    const r2 = await compor(b);
    assert.equal(r1.identidade.sha256Manifesto, r2.identidade.sha256Manifesto);
    const repetida = await compor(a);
    falhaEsperada(repetida, 'COPIA', 'DESTINO_EXISTENTE');
    assert.equal((await criarSelagem().verificar({ area: a.area, esperado: { ...r1.identidade } })).ok, true);
  });

  teste('COM-06c — o manifesto só contém as chaves do PLANO daquele contexto: arquivos de empresa ou conjunto estranhos nunca entram, mesmo existindo no destino', async () => {
    const c = await cenario();
    await c.destino.gravar(`9/${H('1')}/mestre.png`, Buffer.from('estranho'), { maxBytes: 100 });
    const r = await compor(c);
    assert.equal(r.ok, true);
    assert.deepEqual(r.manifesto.arquivos.map((a) => a.chave), c.plano.map((p) => p.chave));
    assert.equal(r.manifesto.arquivos.some((a) => a.chave.startsWith('9/')), false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- COM-07
describe('[COM-07] segurança: a área vem da composição confiável; nada afirma publicação ou recuperabilidade', () => {
  teste('COM-07a — `compor` é ESTRITO: `area` (ou qualquer chave extra) por chamada é recusada com ENTRADA/ENTRADA_INVALIDA, sem copiar nem selar, e nada é escrito na área sugerida', async () => {
    const c = await cenario();
    const alheia = pasta();
    const eventos = [];
    const composicao = composicaoModulo().criarComposicaoDoConjunto({ copiar: copiarObservada(c.copiar, eventos), selagem: selagemObservada(eventos), area: c.area, conjuntoId: CONJUNTO });
    for (const entrada of [{ contexto: c.contexto, dump: DUMP_FICTICIO, area: alheia }, { contexto: c.contexto, dump: DUMP_FICTICIO, conjuntoId: 'x' }, { contexto: c.contexto }, { dump: DUMP_FICTICIO }, null, 'x', []]) {
      falhaEsperada(await composicao.compor(entrada), 'ENTRADA', 'ENTRADA_INVALIDA');
    }
    assert.deepEqual(eventos, []);
    assert.deepEqual(listar(alheia), []);
    semArtefatos(c.area);
  });

  teste('COM-07b — a criação é ESTRITA e valida a área SEM tocar o disco: relativa, com `..`, com NUL, não string ou chaves desconhecidas lançam TypeError; dependências inválidas também', async () => {
    const c = await cenario();
    const { criarComposicaoDoConjunto } = composicaoModulo();
    const base = { copiar: c.copiar, selagem: criarSelagem(), area: c.area, conjuntoId: CONJUNTO };
    for (const ruim of [
      { ...base, area: 'relativo/dir' }, { ...base, area: `${c.area}/../x` }, { ...base, area: `${c.area}\0x` }, { ...base, area: 123 }, { ...base, area: undefined },
      { ...base, extra: 1 }, { ...base, copiar: 'x' }, { ...base, selagem: {} }, { ...base, selagem: { selar: () => {} } }, { ...base, conjuntoId: 5 },
    ]) assert.throws(() => criarComposicaoDoConjunto(ruim), TypeError);
    assert.throws(() => criarComposicaoDoConjunto(null), TypeError);
    assert.equal(fs.readdirSync(c.raiz).includes('x'), false);
  });

  teste('COM-07c — NENHUM resultado (sucesso, cada estágio de falha) declara `recuperavel`, prova de restauração, `restaurado` ou `publicado`; falhas não levam caminhos, mensagens de dependência nem valores recebidos', async () => {
    const c = await cenario();
    const resultados = [await compor(c)];
    resultados.push(await compor(c)); // SELAGEM: área já usada
    resultados.push(await compor(await cenario({ omitir: 0 })));
    resultados.push(await compor(await cenario(), { dump: { ...DUMP_FICTICIO, concluido: false } }));
    for (const r of resultados) { semAfirmacoes(r); if (!r.ok) semVazamento(r); }
  });

  teste('COM-07d — as entradas do chamador não são alteradas: `contexto` e `dump` congelados continuam iguais; a composição lê cada valor uma vez (getter instável não muda o manifesto)', async () => {
    const c = await cenario();
    const antes = JSON.stringify(c.contexto);
    let leituras = 0;
    const dump = { concluido: true, bytes: 1234, sha256Declarado: H('7') };
    Object.defineProperty(dump, 'sha256Recalculado', { enumerable: true, get: () => { leituras += 1; return leituras === 1 ? H('7') : H('8'); } });
    const r = await compor(c, { dump });
    assert.equal(r.ok, true);
    assert.equal(r.manifesto.dump.sha256, H('7'));
    assert.ok(leituras <= 1);
    assert.equal(JSON.stringify(c.contexto), antes);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- pendências
describe('[PENDÊNCIAS] bloqueios operacionais, registrados e NÃO resolvidos por esta composição', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('COM-09a — LIGAÇÃO às etapas de `executarBackupOperacional`: `avaliar` recebe só os nomes das etapas (CTL-01), então o fechamento sobre `contexto`, cópia e dump precisa ser montado por um chamador confiável (a composição roda dentro da janela, antes da liberação da trava); definir o ponto exato', 'incremento próprio');
  todo('COM-09b — produtor REAL e independente de `sha256Recalculado` do dump (hash físico do arquivo), hoje inexistente; sem ele o manifesto só registra evidência', 'incremento próprio');
  todo('COM-09c — TOCTOU em caminhos e na limpeza (sem `openat`/`renameat2`), e destino parcial deixado por uma cópia que falhou (política de descarte da preparação)', 'limite da plataforma/decisão');
  todo('COM-09d — contenção e identidade de processos do `pg_dump`, trava de escrita em todos os escritores de imagem e snapshot que não congela arquivos', 'bloqueio operacional');
  todo('COM-09e — publicação atômica do conjunto sem sobrescrita, durabilidade real após queda de energia e autenticidade do hash (assinatura/HMAC)', 'decisão de arquitetura');
  todo('COM-09f — restauração independente: só ela pode tornar um conjunto recuperável; a composição jamais declara isso', 'incremento próprio');
});
