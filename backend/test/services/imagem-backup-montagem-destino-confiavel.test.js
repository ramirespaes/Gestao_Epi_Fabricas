'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { types } = require('node:util');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { criarCopiaDeImagens } = require('../../src/services/imagem-backup-copia.service');
const { criarSelagem } = require('../../src/services/imagem-backup-selagem.service');
const { criarComposicaoDoConjunto } = require('../../src/services/imagem-backup-composicao.service');
const { criarVerificadorDeImagensCopiadas } = require('../../src/services/imagem-backup-verificacao-imagens-copiadas.service');
const { criarEtapaDeCopiaVerificada } = require('../../src/services/imagem-backup-copia-verificada.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-VF09-MONTAGEM-CONFIAVEL-DESTINO-1): MONTAGEM CONFIÁVEL que deriva a cópia, o verificador físico, o vínculo `copiarVerificado` e a composição de UMA
 * ÚNICA preparação por operação (VF-09). Só dados FICTÍCIOS em diretórios temporários exclusivos (prefixo `gepi-vf09-test-`): a fábrica do armazenamento CRIA o diretório informado, então nada aqui usa
 * caminho de `.env` ou de configuração real. Nada toca PostgreSQL, `pg_dump`, processo real ou imagens reais; evidência de dump FICTÍCIA; nada aqui é backup válido, publicado ou recuperável.
 *
 * CONTRATOS REAIS CONFIRMADOS (CTL-01 a CTL-04 executam):
 *   - `criarArmazenamentoImagens({ diretorio })` (armazenamento-imagens.js:72): caminho ABSOLUTO; CRIA o diretório (mkdir recursivo) e fixa a raiz com `realpath` NA CRIAÇÃO (linha 80), numa `const` da closure;
 *     devolve um objeto congelado { gravar, abrir, existe, remover, removerVariantes, listar, chaveDe } que NÃO expõe raiz nem identificador de instância;
 *   - `criarCopiaDeImagens({ origem, destino, maxBytesPorArquivo })` usa `origem.abrir`, `destino.existe` e `destino.gravar`; `criarVerificadorDeImagensCopiadas({ destino })` usa `destino.abrir`: são construídos
 *     por quem chama, com objetos INDEPENDENTES (CTL-02: cópia em A e verificador em B, ambos com os mesmos arquivos, e o verificador aprova mesmo com o arquivo ausente em A);
 *   - `criarEtapaDeCopiaVerificada({ copiar, verificador })` e `criarComposicaoDoConjunto({ copiar, selagem, area, conjuntoId })` recebem funções/objetos opacos: nenhuma checagem de que usam o mesmo destino;
 *   - a `area` da composição só precisa ser um diretório absoluto existente e canônico (a selagem grava `manifesto.json` e `manifesto.sha256` NELA): NENHUMA relação com a raiz do armazenamento é exigida (CTL-04);
 *   - o texto do caminho NÃO é identidade: dois textos (um link e o diretório real) resolvem para a mesma raiz física e o MESMO texto, em momentos diferentes, pode resolver para raízes diferentes (CTL-03).
 *
 * INTERFACE PROVISÓRIA (nada em produção; o nome do módulo e a interface NÃO estão aprovados): src/services/imagem-backup-montagem-destino-confiavel.service.js exporta
 *   `criarMontagemDeDestinoConfiavel({ preparacao, origem, conjuntoId, maxBytesPorArquivo, selagem? })` (ESTRITO; TypeError sem eco; chamador CONFIÁVEL; uma montagem por operação) -> congelado { compor, obterVerificacao }:
 *   - `preparacao` = diretório ABSOLUTO, canônico (sem `..`, NUL nem link simbólico em nenhum componente), JÁ EXISTENTE (a montagem não cria preparações arbitrárias); é a `area` do manifesto;
 *   - LAYOUT PROVISÓRIO (decisão a aprovar, não presumida): a raiz do armazenamento é o subdiretório FIXO `imagens` da preparação, criado pelo próprio montador (`<preparacao>/imagens`); o manifesto fica em
 *     `<preparacao>/manifesto.*`. Nome fixo, não parâmetro: não há combinação arbitrária entre preparação e área. Imagens nunca no nível da preparação, manifesto nunca dentro de `imagens`;
 *   - `origem` = capacidade de LEITURA da origem (precisa de `abrir`), fornecida pelo chamador confiável; `selagem` opcional (padrão: `criarSelagem()`); `maxBytesPorArquivo` e `conjuntoId` como nos módulos existentes;
 *   - o montador cria UM armazenamento sobre `<preparacao>/imagens` e dele deriva `destino` da cópia, `destino` do verificador e (portanto) o vínculo e a composição; o chamador NÃO pode fornecer `copiar`,
 *     `verificador`, `destino`, `armazenamento`, `area` ou qualquer outra chave: TypeError;
 *   - `compor({ contexto, dump })` = o da composição existente (estrito, consumo único herdado da etapa); `obterVerificacao()` = o do vínculo (classes DIVERGENCIA_COMPROVADA | INCONCLUSIVA | RETORNO_INVALIDO |
 *     NAO_EXECUTADA | INTEGRA, `null` até haver resultado). Nada expõe armazenamento, raiz física, copiar ou verificador.
 *
 * O QUE ESTE RED PODE E NÃO PODE PROVAR (sem inventar prova): que as duas pontas derivam do MESMO objeto é verdade POR CONSTRUÇÃO (inspeção estrutural do futuro código); por teste só se observa o efeito: o
 * verificador enxerga as alterações feitas em `<preparacao>/imagens` durante a operação e ignora uma preparação-isca idêntica, e a árvore criada tem uma única raiz (MON-01/MON-03). Quantas vezes a fábrica
 * foi chamada NÃO é observável sem patch global: TODO. A montagem estabelece só a PRIMEIRA garantia (mesma capacidade); não a segunda (continuidade física apesar de troca de caminhos) nem a terceira (imutabilidade).
 *
 * COMO LER: o módulo NÃO existe; falhas por "módulo ausente" NÃO são provas comportamentais independentes. Os CTL-* passam hoje.
 */

const MODULO = 'src/services/imagem-backup-montagem-destino-confiavel.service';
const modulo = () => exigirModulo(MODULO);
const PRAZO = 30000;
const PREFIXO = 'gepi-vf09-test-';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const CONJUNTO = 'conjunto-vf09-0001';
const teste = (nome, fn, opcoes = {}) => test(nome, { timeout: PRAZO, ...opcoes }, fn);
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DUMP_FICTICIO = Object.freeze({ concluido: true, bytes: 1234, sha256Declarado: H('7'), sha256Recalculado: H('7') });
const SEM_PERMISSAO_DE_DIRETORIO = typeof process.getuid === 'function' && process.getuid() === 0 ? 'executando como root: chmod não restringe' : false;

// ------------------------------------------------------------------------------------------------------------------------------- infraestrutura
const raizes = [];
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of raizes) {
    try { fs.chmodSync(p, 0o700); } catch { /* removido */ }
    if (path.dirname(p) === tmp && path.basename(p).startsWith(PREFIXO)) {
      // restaura permissões restritas pelos próprios testes antes de remover
      try { for (const e of fs.readdirSync(p, { recursive: true })) { try { fs.chmodSync(path.join(p, e), fs.statSync(path.join(p, e)).isDirectory() ? 0o700 : 0o600); } catch { /* ignora */ } } } catch { /* ignora */ }
      fs.rmSync(p, { recursive: true, force: true });
    }
  }
});
function pasta(rotulo = 'raiz') {
  const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `${PREFIXO}${rotulo}-`)));
  fs.chmodSync(p, 0o700);
  raizes.push(p);
  return p;
}
const arvore = (dir) => fs.readdirSync(dir, { recursive: true }).sort();

/** Origem fictícia semeada (8 arquivos) e o plano; a PREPARAÇÃO existe vazia (como um chamador confiável a entregaria). */
async function cenario() {
  const raiz = pasta('cenario');
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
  const origemReal = criarArmazenamentoImagens({ diretorio: path.join(raiz, 'origem') });
  for (const item of plano) await origemReal.gravar(item.chave, conteudos.find((c) => sha(c) === item.sha256), { maxBytes: 4096, sha256Esperado: item.sha256 });
  const preparacao = path.join(raiz, 'preparacao');
  fs.mkdirSync(preparacao, { mode: 0o700 });
  const contexto = Object.freeze({ snapshotId: '0-0-0', banco: Object.freeze({ nome: 'gestao_epi', oid: '16384' }), registros, plano });
  return { raiz, preparacao, plano, contexto, origemReal, conteudos };
}

/** Origem observada: delega à origem real, conta as aberturas e permite ganchos (por exemplo, alterar o destino enquanto o ÚLTIMO arquivo é lido). */
function origemObservada(c, { aoAbrir = null } = {}) {
  const estado = { aberturas: 0, chaves: [] };
  return {
    estado,
    async abrir(chave) {
      estado.aberturas += 1;
      estado.chaves.push(chave);
      if (aoAbrir) await aoAbrir(chave, estado.aberturas);
      return c.origemReal.abrir(chave);
    },
  };
}
const selagemObservada = (eventos, aoSelar = null) => {
  const real = criarSelagem();
  return {
    selar: async (e) => { eventos.push('selar'); if (aoSelar) aoSelar(); return real.selar(e); },
    verificar: async (e) => { eventos.push('verificar-selagem'); return real.verificar(e); },
  };
};
const montar = (c, extras = {}) => modulo().criarMontagemDeDestinoConfiavel({ preparacao: c.preparacao, origem: extras.origem ?? c.origemReal, conjuntoId: CONJUNTO, maxBytesPorArquivo: 4096, ...extras.parametros });
const fisico = (c, chave) => path.join(c.preparacao, 'imagens', chave);
const semVazamento = (valor, c) => {
  const t = JSON.stringify(valor);
  for (const proibido of [SEGREDO, os.tmpdir(), PREFIXO, ...(c ? [c.preparacao, c.raiz] : [])]) assert.equal(t.includes(proibido), false, proibido);
};
/**
 * Percurso LOCAL à fixture do grafo alcançável a partir de um valor, para provar que nenhuma capacidade do armazenamento vaza. Só descritores e nomes de chave são lidos (nenhum getter e nenhuma função é
 * executada); propriedades próprias (strings e Symbols), valores aninhados, arrays, funções com propriedades próprias e a cadeia de protótipos são percorridos, com WeakSet contra ciclos e SEM limite de
 * profundidade. Intrínsecos conhecidos (Object/Function/Array.prototype) têm só os NOMES verificados (têm acessores legítimos que não podem ser percorridos sem executá-los). O que o percurso não consegue
 * inspecionar com segurança (Proxy, acessor em objeto não intrínseco, Map/Set/WeakMap/WeakSet/WeakRef/Promise) vai para `incompleta`: a ausência de exposição NÃO é declarada nesses casos.
 */
const CAPACIDADES_PROIBIDAS = Object.freeze(['gravar', 'remover', 'removerVariantes', 'abrir', 'existe', 'listar', 'chaveDe']);
const INTRINSECOS_CONHECIDOS = new Set([Object.prototype, Function.prototype, Array.prototype]);
function inspecionarExposicao(inicio, { referenciasProibidas = [] } = {}) {
  const vistos = new WeakSet();
  const violacoes = [];
  const incompleta = [];
  let visitados = 0;
  const pilha = [{ valor: inicio, caminho: 'raiz' }];
  while (pilha.length > 0) {
    const { valor, caminho } = pilha.pop();
    if (valor === null || (typeof valor !== 'object' && typeof valor !== 'function')) continue;
    if (vistos.has(valor)) continue;
    vistos.add(valor);
    visitados += 1;
    if (referenciasProibidas.includes(valor)) violacoes.push(`${caminho}: referência a objeto proibido`);
    if (types.isProxy(valor)) { incompleta.push(`${caminho}: Proxy`); continue; }
    if (types.isMap(valor) || types.isSet(valor) || types.isWeakMap(valor) || types.isWeakSet(valor) || types.isPromise(valor) || (typeof WeakRef === 'function' && valor instanceof WeakRef)) {
      incompleta.push(`${caminho}: conteúdo interno não inspecionável`);
    }
    const intrinseco = INTRINSECOS_CONHECIDOS.has(valor);
    for (const chave of Reflect.ownKeys(valor)) {
      if (typeof chave === 'string' && CAPACIDADES_PROIBIDAS.includes(chave)) violacoes.push(`${caminho}.${chave}`);
      if (intrinseco) continue;
      const descritor = Object.getOwnPropertyDescriptor(valor, chave);
      if (descritor && Object.hasOwn(descritor, 'value')) pilha.push({ valor: descritor.value, caminho: `${caminho}.${String(chave)}` });
      else incompleta.push(`${caminho}.${String(chave)}: acessor não executado`);
    }
    const prototipo = Reflect.getPrototypeOf(valor);
    if (prototipo !== null) pilha.push({ valor: prototipo, caminho: `${caminho}[[Prototype]]` });
  }
  return { violacoes, incompleta, visitados };
}
const semAfirmacoes = (valor) => {
  const t = JSON.stringify(valor).toLowerCase();
  for (const proibida of ['"valido"', 'recuper', 'publicad', 'restaur', 'veredito']) assert.equal(t.includes(proibida), false, proibida);
};

// ------------------------------------------------------------------------------------------------------------------------------- controles
describe('[CTL] controles que passam hoje: as fábricas atuais e o que elas NÃO garantem', () => {
  teste('CTL-01 (VF09-01) — fábricas atuais montadas à mão sobre UM armazenamento: a fábrica CRIA o diretório; cópia real, verificador real e o vínculo existente funcionam (INTEGRA, 8 examinados) e a composição real sela; o manifesto fica na área e as imagens no armazenamento', async () => {
    const c = await cenario();
    const raizImagens = path.join(c.preparacao, 'imagens');
    assert.equal(fs.existsSync(raizImagens), false);
    const destino = criarArmazenamentoImagens({ diretorio: raizImagens });
    assert.equal(fs.statSync(raizImagens).isDirectory(), true, 'a fábrica criou o diretório informado');
    const etapa = criarEtapaDeCopiaVerificada({ copiar: criarCopiaDeImagens({ origem: c.origemReal, destino, maxBytesPorArquivo: 4096 }), verificador: criarVerificadorDeImagensCopiadas({ destino }) });
    const r = await criarComposicaoDoConjunto({ copiar: etapa.copiarVerificado, selagem: criarSelagem(), area: c.preparacao, conjuntoId: CONJUNTO }).compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.equal(r.ok, true);
    assert.equal(etapa.obterVerificacao().classe, 'INTEGRA');
    assert.equal(etapa.obterVerificacao().verificacao.examinados, 8);
    assert.deepEqual(fs.readdirSync(c.preparacao).sort(), ['imagens', 'manifesto.json', 'manifesto.sha256']);
  });

  teste('CTL-02 (VF09-03) — CENÁRIO A/B ADMITIDO pelos componentes atuais: a cópia grava em A, o verificador (real) lê B, com chaves e conteúdos idênticos; mesmo com um arquivo AUSENTE em A o verificador aprova (ok:true): hashes iguais não provam a mesma preparação', async () => {
    const c = await cenario();
    const a = criarArmazenamentoImagens({ diretorio: path.join(c.raiz, 'prep-A') });
    const b = criarArmazenamentoImagens({ diretorio: path.join(c.raiz, 'prep-B') });
    const copiaEmA = await criarCopiaDeImagens({ origem: c.origemReal, destino: a, maxBytesPorArquivo: 4096 })(c.contexto);
    await criarCopiaDeImagens({ origem: c.origemReal, destino: b, maxBytesPorArquivo: 4096 })(c.contexto); // a isca B recebe os mesmos arquivos
    // REMOÇÃO EXTERNA explícita (o armazenamento recusa remover sem a posse da janela de LIMPEZA): o arquivo some de A por fora da aplicação.
    fs.unlinkSync(path.join(c.raiz, 'prep-A', ...c.plano[0].chave.split('/')));
    assert.equal(await a.existe(c.plano[0].chave), false);
    const v = await criarVerificadorDeImagensCopiadas({ destino: b }).verificar({ plano: c.plano, copia: copiaEmA });
    assert.deepEqual({ concluida: v.concluida, ok: v.ok, examinados: v.examinados }, { concluida: true, ok: true, examinados: 8 });
    const vEmA = await criarVerificadorDeImagensCopiadas({ destino: a }).verificar({ plano: c.plano, copia: copiaEmA });
    assert.equal(vEmA.ok, false, 'lendo a preparação CORRETA o problema aparece');
  });

  teste('CTL-03 (VF09-09) — o caminho textual NÃO é identidade e a raiz é fixada NA CRIAÇÃO: um link e o diretório real são textos diferentes da MESMA raiz física; o MESMO texto de link, reapontado depois, passa a resolver outra raiz; o armazenamento já criado continua na raiz antiga (realpath resolvido uma vez)', async () => {
    const c = await cenario();
    const dirA = path.join(c.raiz, 'dir-A');
    const dirB = path.join(c.raiz, 'dir-B');
    fs.mkdirSync(dirA, { mode: 0o700 });
    fs.mkdirSync(dirB, { mode: 0o700 });
    const ligacao = path.join(c.raiz, 'ligacao');
    fs.symlinkSync(dirA, ligacao);
    const pelaLigacao = criarArmazenamentoImagens({ diretorio: ligacao });
    const pelaRaiz = criarArmazenamentoImagens({ diretorio: dirA });
    const chave = c.plano[0].chave;
    await pelaLigacao.gravar(chave, c.conteudos.find((b) => sha(b) === c.plano[0].sha256), { maxBytes: 4096 });
    assert.equal(await pelaRaiz.existe(chave), true, 'textos diferentes, mesma raiz física');
    fs.rmSync(ligacao);
    fs.symlinkSync(dirB, ligacao); // o mesmo texto agora aponta para outra raiz
    const depois = criarArmazenamentoImagens({ diretorio: ligacao });
    assert.equal(await depois.existe(chave), false, 'o mesmo texto resolveu outra raiz');
    assert.equal(await pelaLigacao.existe(chave), true, 'o armazenamento criado antes continua na raiz antiga');
  });

  teste('CTL-04 (VF09-04) — a composição atual NÃO relaciona `area` e raiz do armazenamento: com a área em um diretório e as imagens em outro, a composição sela normalmente; a relação precisa ser imposta pelo montador', async () => {
    const c = await cenario();
    const destino = criarArmazenamentoImagens({ diretorio: path.join(c.raiz, 'imagens-em-outro-lugar') });
    const outraArea = path.join(c.raiz, 'area-sem-relacao');
    fs.mkdirSync(outraArea, { mode: 0o700 });
    const etapa = criarEtapaDeCopiaVerificada({ copiar: criarCopiaDeImagens({ origem: c.origemReal, destino, maxBytesPorArquivo: 4096 }), verificador: criarVerificadorDeImagensCopiadas({ destino }) });
    const r = await criarComposicaoDoConjunto({ copiar: etapa.copiarVerificado, selagem: criarSelagem(), area: outraArea, conjuntoId: CONJUNTO }).compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.equal(r.ok, true);
    assert.deepEqual(fs.readdirSync(outraArea).sort(), ['manifesto.json', 'manifesto.sha256']);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MON-01 / MON-02
describe('[MON] montagem confiável: capacidade única, layout e parâmetros', () => {
  teste('MON-01 (VF09-02/04) — capacidade e LAYOUT: uma montagem sobre uma preparação existente cria UMA raiz de imagens (`<preparacao>/imagens`) e nada mais fora dela; as imagens ficam só em `imagens/`, o manifesto só no nível da preparação; a interface expõe apenas { compor, obterVerificacao } e não revela a raiz', async () => {
    const c = await cenario();
    // Calibração do percurso (roda mesmo sem o módulo): detecta as capacidades de um armazenamento real, atravessa ciclos e funções com propriedades, e NÃO declara sucesso diante de um Proxy ou acessor.
    const armazenamentoDeReferencia = criarArmazenamentoImagens({ diretorio: path.join(c.raiz, 'referencia-da-calibracao') });
    const achado = inspecionarExposicao({ aninhado: [{ dentro: armazenamentoDeReferencia }] });
    assert.deepEqual(CAPACIDADES_PROIBIDAS.filter((n) => achado.violacoes.some((v) => v.endsWith(`.${n}`))), [...CAPACIDADES_PROIBIDAS], 'o percurso enxerga todas as capacidades proibidas');
    assert.ok(inspecionarExposicao({ x: armazenamentoDeReferencia }, { referenciasProibidas: [armazenamentoDeReferencia] }).violacoes.some((v) => v.includes('referência a objeto proibido')));
    const cicloA = {}; cicloA.volta = cicloA; const fn = () => {}; fn.extra = { volta: cicloA }; cicloA.fn = fn;
    const ciclo = inspecionarExposicao(cicloA);
    assert.deepEqual([ciclo.violacoes, ciclo.incompleta], [[], []]);
    assert.ok(inspecionarExposicao({ p: new Proxy({}, {}) }).incompleta.some((i) => i.includes('Proxy')));
    assert.ok(inspecionarExposicao({ get oculto() { return 1; } }).incompleta.some((i) => i.includes('acessor')));
    assert.ok(inspecionarExposicao({ [Symbol('s')]: { gravar() {} } }).violacoes.some((v) => v.endsWith('.gravar')), 'propriedades Symbol também são percorridas');

    const antes = arvore(c.raiz);
    const m = montar(c);
    assert.deepEqual(Object.keys(m).sort(), ['compor', 'obterVerificacao']);
    assert.equal(Object.isFrozen(m), true);
    assert.deepEqual(arvore(c.raiz).filter((n) => !antes.includes(n)), ['preparacao/imagens'], 'só a raiz de imagens foi criada');
    const r = await m.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.equal(r.ok, true);
    assert.equal(r.arquivos, 8);
    assert.deepEqual(fs.readdirSync(c.preparacao).sort(), ['imagens', 'manifesto.json', 'manifesto.sha256']);
    for (const item of c.plano) assert.equal(fs.existsSync(fisico(c, item.chave)), true, item.chave);
    assert.equal(fs.readdirSync(path.join(c.preparacao, 'imagens')).some((n) => n.startsWith('manifesto')), false);
    assert.equal(m.obterVerificacao().classe, 'INTEGRA');
    semVazamento(r, c);
    semVazamento(m.obterVerificacao(), c);
    semAfirmacoes(r);

    // NÃO EXPOSIÇÃO das capacidades do armazenamento: montagem, resultado de `compor()` e diagnóstico de `obterVerificacao()`. As funções públicas legítimas (`compor`, `obterVerificacao`) são permitidas.
    // Referência conhecida da fixture: a origem (outro armazenamento, entregue pelo chamador) também não pode ser devolvida; a instância criada INTERNAMENTE pela montagem não é acessível à fixture.
    const referenciasDaFixture = [c.origemReal, armazenamentoDeReferencia];
    const resultados = [['montagem', m], ['compor()', r], ['obterVerificacao()', m.obterVerificacao()]];
    for (const [rotulo, valor] of resultados) {
      const exposicao = inspecionarExposicao(valor, { referenciasProibidas: referenciasDaFixture });
      assert.deepEqual(exposicao.violacoes, [], `${rotulo}: nenhuma capacidade nem referência proibida alcançável`);
      assert.deepEqual(exposicao.incompleta, [], `${rotulo}: inspeção completa (sem Proxy, acessor ou contêiner opaco): a ausência de exposição só vale se tudo foi percorrido`);
      assert.ok(exposicao.visitados > 0, rotulo);
    }
    assert.equal(typeof m.compor, 'function');
    assert.equal(typeof m.obterVerificacao, 'function');
  });

  const parametrosHostis = (c) => [
    ['`destino` injetado', { destino: criarArmazenamentoImagens({ diretorio: path.join(c.raiz, 'isca') }) }],
    ['`armazenamento` injetado', { armazenamento: criarArmazenamentoImagens({ diretorio: path.join(c.raiz, 'isca') }) }],
    ['`verificador` pronto', { verificador: { verificar: async () => ({ concluida: true, ok: true, examinados: 8, bytes: 1 }) } }],
    ['`copiar` pronto', { copiar: async () => ({}) }],
    ['`area` própria', { area: c.raiz }],
    ['chave desconhecida', { extra: 1 }],
    ['`preparacao` relativa', { preparacao: 'relativo/dir' }],
    ['`preparacao` com travessia', { preparacao: `${c.preparacao}/../preparacao` }],
    ['`preparacao` com NUL', { preparacao: `${c.preparacao}\0x` }],
    ['`preparacao` inexistente (a montagem não cria preparações)', { preparacao: path.join(c.raiz, 'inexistente') }],
    ['`preparacao` é arquivo', { preparacao: path.join(c.raiz, 'arquivo') }],
    ['`preparacao` não é string', { preparacao: 123 }],
    ['`origem` sem `abrir`', { origem: {} }],
    ['`maxBytesPorArquivo` inválido', { maxBytesPorArquivo: 0 }],
    ['`conjuntoId` não é string', { conjuntoId: 5 }],
    ['`selagem` sem funções', { selagem: {} }],
  ];

  teste('MON-02 (VF09-05) — PARÂMETROS HOSTIS: destino/armazenamento/verificador/copiar/área injetados, chaves desconhecidas, preparação relativa, com travessia, com NUL, inexistente, arquivo ou não string, origem, limite, identificador e selagem malformados são TypeError sem eco de raiz ou segredo, e NADA é criado em disco', async () => {
    modulo(); // sem o módulo, a falha é "módulo ausente" (e não um TypeError qualquer)
    const c = await cenario();
    fs.writeFileSync(path.join(c.raiz, 'arquivo'), 'x');
    const hostis = parametrosHostis(c); // a fixture cria as iscas (diretórios fictícios) AQUI, antes do estado inicial
    const antes = arvore(c.raiz);
    const base = { preparacao: c.preparacao, origem: c.origemReal, conjuntoId: CONJUNTO, maxBytesPorArquivo: 4096 };
    for (const [rotulo, troca] of hostis) {
      assert.throws(() => modulo().criarMontagemDeDestinoConfiavel({ ...base, ...troca }), (e) => {
        assert.ok(e instanceof TypeError, rotulo);
        const texto = `${e.message} ${String(e)}`;
        for (const proibido of [c.raiz, c.preparacao, os.tmpdir(), SEGREDO]) assert.equal(texto.includes(proibido), false, `${rotulo}: ${proibido}`);
        return true;
      }, rotulo);
    }
    for (const ruim of [null, 'x', [], undefined, {}]) assert.throws(() => modulo().criarMontagemDeDestinoConfiavel(ruim), TypeError);
    // `preparacao` com link simbólico (mesmo para um diretório válido) também é recusada
    const ligacao = path.join(c.raiz, 'ligacao-para-preparacao');
    fs.symlinkSync(c.preparacao, ligacao);
    assert.throws(() => modulo().criarMontagemDeDestinoConfiavel({ ...base, preparacao: ligacao }), TypeError);
    const criados = arvore(c.raiz).filter((n) => !antes.includes(n));
    assert.deepEqual(criados, ['ligacao-para-preparacao'], 'nenhuma recusa criou diretório (só o link que o próprio teste plantou)');
    assert.equal(fs.existsSync(path.join(c.preparacao, 'imagens')), false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MON-03
describe('[MON-03] cenário A/B: a montagem não admite preparação independente para o verificador', () => {
  teste('MON-03 (VF09-03) — com uma preparação-ISCA B idêntica por perto, uma alteração feita na preparação da montagem DURANTE a operação (depois de copiar um arquivo, antes da verificação) é DETECTADA: o verificador lê a MESMA preparação em que a cópia gravou, não a isca; a isca íntegra não satisfaz o verificador', async () => {
    const c = await cenario();
    const isca = criarArmazenamentoImagens({ diretorio: path.join(c.raiz, 'isca-B') });
    await criarCopiaDeImagens({ origem: c.origemReal, destino: isca, maxBytesPorArquivo: 4096 })(c.contexto);
    const alvo = c.plano[0].chave;
    const origem = origemObservada(c, { aoAbrir: async (chave) => { if (chave === c.plano[c.plano.length - 1].chave) fs.rmSync(fisico(c, alvo)); } });
    const m = montar(c, { origem });
    const r = await m.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.deepEqual({ ok: r.ok, selado: r.selado, ...r.falha }, { ok: false, selado: false, estagio: 'COPIA', codigo: 'INTEGRIDADE_DIVERGENTE' });
    const v = m.obterVerificacao();
    assert.equal(v.classe, 'DIVERGENCIA_COMPROVADA');
    assert.deepEqual(v.verificacao.divergencias.map((d) => ({ ...d })), [{ chave: alvo, codigo: 'ARQUIVO_AUSENTE' }]);
    assert.equal(await isca.existe(alvo), true, 'a isca estava íntegra: se fosse lida, a verificação teria aprovado');
    assert.equal(fs.existsSync(path.join(c.preparacao, 'manifesto.json')), false);
    semVazamento(r, c);
  });

  teste('MON-03b — igualdade de hashes e de nomes NÃO é identidade: duas montagens sobre preparações DIFERENTES com os mesmos arquivos produzem manifestos com o mesmo SHA-256, mas cada uma só enxerga a própria preparação (alterar uma não afeta a outra)', async () => {
    const a = await cenario();
    const b = await cenario();
    const ma = montar(a);
    const mb = montar(b, { parametros: { conjuntoId: CONJUNTO } });
    const [ra, rb] = await Promise.all([ma.compor({ contexto: a.contexto, dump: DUMP_FICTICIO }), mb.compor({ contexto: b.contexto, dump: DUMP_FICTICIO })]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true);
    assert.equal(ra.identidade.sha256Manifesto, rb.identidade.sha256Manifesto);
    fs.appendFileSync(fisico(a, a.plano[0].chave), Buffer.from('x'));
    assert.equal(fs.statSync(fisico(a, a.plano[0].chave)).size !== fs.statSync(fisico(b, b.plano[0].chave)).size, true);
    assert.equal(ma.obterVerificacao().classe, 'INTEGRA', 'o resultado definitivo anterior não muda');
    assert.notEqual(ma.obterVerificacao(), mb.obterVerificacao());
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MON-04 / MON-05
describe('[MON-04 / MON-05] execução única, ordem, divergência e falhas', () => {
  teste('MON-04 (VF09-06) — UMA cópia (a origem é lida exatamente uma vez por arquivo), verificação física antes do manifesto (no instante de `selar` o resultado lateral já é INTEGRA e as imagens estão completas), selagem só depois; segunda `compor` na mesma montagem é recusada sem nova cópia; resultado da cópia preservado', async () => {
    const c = await cenario();
    const eventos = [];
    let classeNoSelar = null;
    let imagensNoSelar = null;
    const origem = origemObservada(c);
    let m;
    const selagem = selagemObservada(eventos, () => {
      classeNoSelar = m.obterVerificacao() === null ? null : m.obterVerificacao().classe;
      imagensNoSelar = c.plano.every((p) => fs.existsSync(fisico(c, p.chave)));
    });
    m = montar(c, { origem, parametros: { selagem } });
    const r = await m.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.equal(r.ok, true);
    assert.equal(origem.estado.aberturas, 8, 'cada arquivo da origem foi aberto uma vez');
    assert.equal(new Set(origem.estado.chaves).size, 8);
    assert.equal(classeNoSelar, 'INTEGRA');
    assert.equal(imagensNoSelar, true);
    assert.deepEqual(eventos, ['selar', 'verificar-selagem']);
    const segunda = await m.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.deepEqual({ ok: segunda.ok, selado: segunda.selado, ...segunda.falha }, { ok: false, selado: false, estagio: 'COPIA', codigo: 'COPIA_FALHOU' });
    assert.equal(origem.estado.aberturas, 8, 'nenhuma segunda cópia');
    assert.deepEqual(eventos, ['selar', 'verificar-selagem'], 'nenhuma segunda selagem');
    assert.equal(m.obterVerificacao().classe, 'INTEGRA');
  });

  teste('MON-05a (VF09-07) — DIVERGÊNCIA comprovada (arquivo adulterado na preparação depois de copiado): DIVERGENCIA_COMPROVADA com o código original, composição COPIA/INTEGRIDADE_DIVERGENTE, sem manifesto, sem selagem, sem repetir a cópia', async () => {
    const c = await cenario();
    const eventos = [];
    const alvo = c.plano[2].chave;
    const origem = origemObservada(c, { aoAbrir: async (chave) => { if (chave === c.plano[c.plano.length - 1].chave) { const b = fs.readFileSync(fisico(c, alvo)); fs.writeFileSync(fisico(c, alvo), Buffer.alloc(b.length, 0x78)); } } });
    const m = montar(c, { origem, parametros: { selagem: selagemObservada(eventos) } });
    const r = await m.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.deepEqual({ ...r.falha }, { estagio: 'COPIA', codigo: 'INTEGRIDADE_DIVERGENTE' });
    assert.deepEqual(m.obterVerificacao().verificacao.divergencias.map((d) => ({ ...d })), [{ chave: alvo, codigo: 'SHA256_DIVERGENTE' }]);
    assert.deepEqual(eventos, []);
    assert.equal(origem.estado.aberturas, 8);
    assert.equal(fs.existsSync(path.join(c.preparacao, 'manifesto.json')), false);
  });

  teste('MON-05b (VF09-07) — INCONCLUSIVA REAL (a leitura de um diretório da preparação falha por permissão): INCONCLUSIVA com LEITURA_FALHOU, composição COPIA/COPIA_FALHOU (nunca INTEGRIDADE_DIVERGENTE), sem manifesto e sem selagem', async () => {
    const c = await cenario();
    const eventos = [];
    const dirAlvo = path.join(c.preparacao, 'imagens', '7', H('c'));
    const origem = origemObservada(c, { aoAbrir: async (chave) => { if (chave === c.plano[c.plano.length - 1].chave) fs.chmodSync(dirAlvo, 0o000); } });
    const m = montar(c, { origem, parametros: { selagem: selagemObservada(eventos) } });
    let r;
    try { r = await m.compor({ contexto: c.contexto, dump: DUMP_FICTICIO }); } finally { fs.chmodSync(dirAlvo, 0o700); }
    assert.deepEqual({ ...r.falha }, { estagio: 'COPIA', codigo: 'COPIA_FALHOU' });
    const v = m.obterVerificacao();
    assert.equal(v.classe, 'INCONCLUSIVA');
    assert.deepEqual({ ...v.verificacao }, { concluida: false, ok: false, motivo: 'LEITURA_FALHOU' });
    assert.deepEqual(eventos, []);
    assert.equal(fs.existsSync(path.join(c.preparacao, 'manifesto.json')), false);
    semVazamento(r, c);
    semVazamento(v, c);
  }, { skip: SEM_PERMISSAO_DE_DIRETORIO });

  teste('MON-05c (VF09-07) — NAO_EXECUTADA (a origem não tem um arquivo): a verificação física não roda, a composição repassa ORIGEM_AUSENTE, sem manifesto e sem selagem, a cópia parcial é preservada na preparação', async () => {
    const c = await cenario();
    const eventos = [];
    const ultima = c.plano[c.plano.length - 1].chave;
    const origem = origemObservada(c, { aoAbrir: async (chave) => { if (chave === ultima) fs.unlinkSync(path.join(c.raiz, 'origem', ...chave.split('/'))); /* REMOÇÃO EXTERNA durante a cópia */ } });
    const m = montar(c, { origem, parametros: { selagem: selagemObservada(eventos) } });
    const r = await m.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.deepEqual({ ...r.falha }, { estagio: 'COPIA', codigo: 'ORIGEM_AUSENTE' });
    assert.deepEqual({ ...m.obterVerificacao() }, { classe: 'NAO_EXECUTADA' });
    assert.deepEqual(eventos, []);
    for (const item of c.plano.slice(0, 7)) assert.equal(fs.existsSync(fisico(c, item.chave)), true, 'cópia parcial preservada');
    assert.equal(fs.existsSync(path.join(c.preparacao, 'manifesto.json')), false);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- MON-06
describe('[MON-06] concorrência, isolamento e pendência', () => {
  teste('MON-06a (VF09-08) — duas operações simultâneas sobre preparações distintas: estados, diagnósticos e preparações separados (A íntegra, B divergente); `obterVerificacao` de uma não vira a da outra; cada montagem tem consumo único próprio', async () => {
    const a = await cenario();
    const b = await cenario();
    const alvoB = b.plano[0].chave;
    const origemB = origemObservada(b, { aoAbrir: async (chave) => { if (chave === b.plano[b.plano.length - 1].chave) fs.rmSync(fisico(b, alvoB)); } });
    const ma = montar(a);
    const mb = montar(b, { origem: origemB });
    const [ra, rb] = await Promise.all([ma.compor({ contexto: a.contexto, dump: DUMP_FICTICIO }), mb.compor({ contexto: b.contexto, dump: DUMP_FICTICIO })]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, false);
    assert.equal(ma.obterVerificacao().classe, 'INTEGRA');
    assert.equal(mb.obterVerificacao().classe, 'DIVERGENCIA_COMPROVADA');
    assert.equal(fs.existsSync(path.join(a.preparacao, 'manifesto.json')), true);
    assert.equal(fs.existsSync(path.join(b.preparacao, 'manifesto.json')), false);
    assert.notEqual(ma.obterVerificacao(), mb.obterVerificacao());
  });

  teste('MON-06b (VF09-08) — PENDÊNCIA com barreira controlada pelo teste (na leitura da origem): enquanto pendente, `compor` não resolve, `obterVerificacao()` é null, a selagem não começa e uma segunda `compor` não reinicia a cópia; liberada a barreira, conclui', async () => {
    const c = await cenario();
    const eventos = [];
    let liberar;
    let comecou;
    const iniciou = new Promise((res) => { comecou = res; });
    const barreira = new Promise((res) => { liberar = res; });
    const origem = origemObservada(c, { aoAbrir: async (chave, n) => { if (n === 3) { comecou(); await barreira; } } });
    const m = montar(c, { origem, parametros: { selagem: selagemObservada(eventos) } });
    let liquidou = false;
    const composicao = m.compor({ contexto: c.contexto, dump: DUMP_FICTICIO }).then((r) => { liquidou = true; return r; });
    await iniciou;
    assert.equal(liquidou, false);
    assert.equal(m.obterVerificacao(), null);
    assert.deepEqual(eventos, []);
    const aberturasAntes = origem.estado.aberturas;
    const segunda = await m.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.deepEqual({ ...segunda.falha }, { estagio: 'COPIA', codigo: 'COPIA_FALHOU' });
    assert.equal(origem.estado.aberturas, aberturasAntes, 'a segunda chamada não reiniciou a cópia');
    liberar();
    const r = await composicao;
    assert.equal(r.ok, true);
    assert.equal(origem.estado.aberturas, 8);
    assert.equal(m.obterVerificacao().classe, 'INTEGRA');
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- pendências
describe('[PENDÊNCIAS] garantias que este RED NÃO prova (registradas)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('VF09-11 — UMA fábrica de armazenamento por montagem: quantas vezes `criarArmazenamentoImagens` é chamada não é observável sem patch global; a identidade do objeto derivada para cópia e verificador é garantia POR CONSTRUÇÃO (inspeção estrutural do futuro código), não prova experimental', 'não observável sem instrumentação de produção');
  todo('VF09-12 — SEGUNDA garantia: continuidade física dos arquivos lidos apesar de troca posterior de caminhos/diretórios (realpath resolvido na criação, `lstat`/`O_NOFOLLOW` não são atômicos, sem `openat`): exige mecanismo operacional ou mudança de armazenamento, fora deste RED', 'limite da plataforma');
  todo('VF09-13 — TERCEIRA garantia: imutabilidade dos arquivos entre verificação, manifesto, selagem e publicação; sem trava de escrita em todos os escritores e sem proteção global; alteração depois da verificação não é detectada até outra verificação', 'limite operacional');
  todo('VF09-14 — RETORNO_INVALIDO não é produzível através da montagem (o verificador real não devolve retorno malformado e o chamador não pode injetá-lo); a classificação segue coberta no nível do vínculo (VF-04C)', 'inalcançável pela interface');
  todo('VF09-15 — o LAYOUT (`<preparacao>/imagens` + manifesto no nível da preparação) é decisão provisória a aprovar; a origem (`origem`) poder ser a própria preparação não é detectável pelos contratos; preparação reutilizada com `imagens/` já populada produz DESTINO_EXISTENTE na cópia', 'decisão pendente');
  todo('VF09-16 — cancelamento seguro de operação pendente, evidência física do pg_dump, fonte independente do hash do dump, autenticidade, publicação atômica, durabilidade e restauração: fora do alcance', 'bloqueio operacional');
});
