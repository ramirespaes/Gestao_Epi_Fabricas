'use strict';

const { describe, test, after } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { lerConfiguracao, exigirDiretorio } = require('../../src/config/imagens');
const { criarArmazenamentoImagens } = require('../../src/storage/armazenamento-imagens');
const { planejarArquivos } = require('../../src/services/imagem-backup-plano.service');
const { criarMontagemDeDestinoConfiavel } = require('../../src/services/imagem-backup-montagem-destino-confiavel.service');

/**
 * BACKUP PERMANENTE da Biblioteca de Imagens (D-ORF-6, RED-INTEGRADO-ORIGEM-PREPARACAO-EXCLUSIVA-1, MARCO A): camada interna confiável ANTERIOR à montagem aprovada. Só dados FICTÍCIOS em diretórios temporários
 * exclusivos (prefixo `gepi-iso-test-`). Nada toca PostgreSQL, `pg_dump`, processo, `.env` real ou imagens reais; evidência de dump FICTÍCIA; nada aqui é backup válido, publicado ou recuperável.
 *
 * INSPEÇÃO CONTRATUAL (resposta às seis perguntas):
 *   1. A raiz física da origem vem da configuração do AMBIENTE: `IMAGENS_ARMAZENAMENTO_DIRETORIO`, lida por `lerConfiguracao(process.env)` (src/config/imagens.js:35,67-73,76): caminho absoluto, canônico (`path.resolve`
 *      igual ao texto), diferente da raiz do sistema; ausente = null (recurso indisponível);
 *   2. É configuração INTERNA confiável (variável de ambiente), não entrada de consumidor; mas `lerConfiguracao` aceita QUALQUER objeto "tipo ambiente": a proveniência garantida é "produzido por `lerConfiguracao`"
 *      (WeakSet `configuracoesProduzidas`; `exigirDiretorio`, linhas 112-117, recusa o que não foi produzido por ele), NÃO "é o ambiente real do processo";
 *   3. A capacidade de leitura é construída nos módulos de AMBIENTE: `criarEntregaDoAmbiente` (imagem-material-entrega.ambiente.js:15) e `criarUploadDoAmbiente` (imagem-material-upload.service.js:182) chamam
 *      `criarArmazenamentoImagens({ diretorio })` com o diretório da configuração; NÃO existe provedor reutilizável de "origem do backup": cada módulo monta o seu;
 *   4. Provedor reutilizável existente: só a configuração (`lerConfiguracao` + `exigirDiretorio`) — é o mecanismo de proveniência aproveitado aqui. Para o DIRETÓRIO-PAI das preparações NÃO existe configuração
 *      nem variável de ambiente (lacuna): o contrato recebe `diretorioPai` de um chamador confiável e a configuração real é pendência (TODO ISO-10);
 *   5. Vínculo entre localização verificada e capacidade: a camada obtém o caminho SÓ de `exigirDiretorio(configuracao)`, canonicaliza (`realpath`), compara e então constrói ELA MESMA a capacidade de leitura com
 *      esse caminho canônico; o consumidor nunca entrega capacidade nem caminho. Atenção: `criarArmazenamentoImagens` CRIA o diretório se ele não existir (CTL-04), então a origem é validada como EXISTENTE antes;
 *   6. O montador GREEN permanece inalterado: recebe `preparacao` (existente) e `origem` (capacidade com `abrir`), exatamente como hoje.
 *
 * INTERFACE MÍNIMA PROPOSTA (provisória; módulo e nomes NÃO aprovados): src/services/imagem-backup-origem-preparacao-exclusiva.service.js exporta
 *   `adquirirPreparacaoExclusiva({ configuracaoDeImagens, diretorioPai, nomeDaPreparacao, conjuntoId, maxBytesPorArquivo, selagem? })` (ASSÍNCRONA; chamador CONFIÁVEL) -> Promise<{ compor, obterVerificacao }> (a MESMA forma
 *   pública da montagem, congelada, sem expor caminho, origem, destino ou armazenamento). Rejeita com Error de `code` FIXO e mensagem fixa sem eco: PARAMETROS_INVALIDOS (TypeError), ORIGEM_INVALIDA, ORIGEM_SOBREPOSTA,
 *   PREPARACAO_EXISTENTE, AQUISICAO_FALHOU. Sequência: (1) valida TUDO sem efeito em disco: chaves estritas (nenhuma capacidade ou caminho de origem, nenhum `origem`, `preparacao`, `destino`, `area`, `copiar`, `verificador`,
 *   `armazenamento`), `configuracaoDeImagens` produzida por `lerConfiguracao` (via `exigirDiretorio`), `diretorioPai` ABSOLUTO, CANÔNICO (realpath igual ao texto), existente e não link simbólico, `nomeDaPreparacao` = UM componente
 *   (/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/, sem `.`/`..`); (2) origem EXISTENTE (diretório) e canonicalizada; (3) SEPARAÇÃO por COMPONENTES de caminho canônico (não por `startsWith` textual): a preparação prospectiva
 *   (`<pai canônico>/<nome>`) não pode ser igual, estar DENTRO da origem, nem conter a origem; (4) AQUISIÇÃO por `mkdir` NÃO recursivo (exclusivo e atômico no filesystem local): entrada existente = PREPARACAO_EXISTENTE, nunca
 *   adoção; (5) revalida a preparação já existente (diretório, sem link, canônica); (6) só então `criarMontagemDeDestinoConfiavel({ preparacao, origem, conjuntoId, maxBytesPorArquivo, selagem })`. Nunca limpa, remove ou reutiliza.
 *
 * LAYOUT DEFINITIVO APROVADO (CTL-05/ISO-09): `<pai>/<nome>/` (= `preparacao` = `area`), `<pai>/<nome>/imagens/` (raiz das imagens), `<pai>/<nome>/manifesto.json` e `manifesto.sha256`.
 *
 * LIMITES (honestos): a proveniência é a de `lerConfiguracao` com um ambiente SIMULADO nestas fixtures: nenhum teste aqui comprova a configuração real da aplicação; a aquisição por `mkdir` é atômica NO FILESYSTEM LOCAL,
 * e a disputa abaixo é de promessas no MESMO processo (não prova resistência entre processos nem durabilidade); a comparação de caminhos é uma verificação PONTUAL (não é identidade física contínua nem elimina TOCTOU,
 * outros escritores ou troca de diretórios depois da validação). COMO LER: o módulo NÃO existe; falhas por "módulo ausente" NÃO são provas comportamentais independentes. Os CTL-* passam hoje.
 */

const MODULO = 'src/services/imagem-backup-origem-preparacao-exclusiva.service';
const modulo = () => exigirModulo(MODULO);
const PRAZO = 30000;
const PREFIXO = 'gepi-iso-test-';
const SEGREDO = 'SEGREDO-NUNCA-EXPOR-123';
const CONJUNTO = 'conjunto-iso-0001';
const teste = (nome, fn, opcoes = {}) => test(nome, { timeout: PRAZO, ...opcoes }, fn);
const H = (c) => c.repeat(64);
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const DUMP_FICTICIO = Object.freeze({ concluido: true, bytes: 1234, sha256Declarado: H('7'), sha256Recalculado: H('7') });
const SEM_PERMISSAO = typeof process.getuid === 'function' && process.getuid() === 0 ? 'executando como root: chmod não restringe' : false;

// ------------------------------------------------------------------------------------------------------------------------------- infraestrutura
const raizes = [];
after(() => {
  const tmp = fs.realpathSync(os.tmpdir());
  for (const p of raizes) {
    if (path.dirname(p) !== tmp || !path.basename(p).startsWith(PREFIXO)) continue;
    try { for (const e of fs.readdirSync(p, { recursive: true })) { try { const q = path.join(p, e); const s = fs.lstatSync(q); if (s.isDirectory()) fs.chmodSync(q, 0o700); } catch { /* ignora */ } } } catch { /* ignora */ }
    fs.rmSync(p, { recursive: true, force: true });
  }
});
const novaRaiz = () => { const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), PREFIXO))); fs.chmodSync(p, 0o700); raizes.push(p); return p; };
const arvore = (dir) => fs.readdirSync(dir, { recursive: true }).sort();

/** Origem fictícia semeada (8 arquivos, via armazenamento real) e diretório-pai das preparações. PROVEDOR SIMULADO: o ambiente é um objeto da fixture passado a `lerConfiguracao` (a função real). */
async function cenario({ nomeOrigem = 'origem', nomePai = 'preparacoes' } = {}) {
  const raiz = novaRaiz();
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
  const dirOrigem = path.join(raiz, nomeOrigem);
  const origemReal = criarArmazenamentoImagens({ diretorio: dirOrigem });
  for (const item of plano) await origemReal.gravar(item.chave, conteudos.find((c) => sha(c) === item.sha256), { maxBytes: 4096, sha256Esperado: item.sha256 });
  const pai = path.join(raiz, nomePai);
  fs.mkdirSync(pai, { mode: 0o700 });
  const ambiente = { IMAGENS_ARMAZENAMENTO_DIRETORIO: dirOrigem };
  const contexto = Object.freeze({ snapshotId: '0-0-0', banco: Object.freeze({ nome: 'gestao_epi', oid: '16384' }), registros, plano });
  return { raiz, dirOrigem, origemReal, pai, ambiente, config: lerConfiguracao(ambiente), plano, contexto, conteudos };
}
const parametros = (c, extras = {}) => ({ configuracaoDeImagens: c.config, diretorioPai: c.pai, nomeDaPreparacao: 'prep-1', conjuntoId: CONJUNTO, maxBytesPorArquivo: 4096, ...extras });
const adquirir = (c, extras = {}) => modulo().adquirirPreparacaoExclusiva(parametros(c, extras));
const configDe = (dir) => lerConfiguracao({ IMAGENS_ARMAZENAMENTO_DIRETORIO: dir });
const semVazamento = (valor, c) => {
  const t = JSON.stringify(valor);
  for (const proibido of [SEGREDO, os.tmpdir(), PREFIXO, ...(c ? [c.raiz] : [])]) assert.equal(t.includes(proibido), false, proibido);
};
async function recusa(promessa, codigo, c, rotulo = '') {
  await assert.rejects(promessa, (e) => {
    assert.ok(e instanceof Error, rotulo);
    assert.equal(e.code, codigo, `${rotulo}: ${e.code}`);
    const texto = `${e.message} ${String(e)}`;
    for (const proibido of [SEGREDO, os.tmpdir(), PREFIXO, ...(c ? [c.raiz] : [])]) assert.equal(texto.includes(proibido), false, `${rotulo}: ${proibido}`);
    return true;
  }, rotulo);
}

// ------------------------------------------------------------------------------------------------------------------------------- ISO-01 controles
describe('[ISO-01] controles que passam hoje (sem o futuro módulo)', () => {
  teste('CTL-01 — PROVENIÊNCIA EXISTENTE: `exigirDiretorio` aceita só a configuração PRODUZIDA por `lerConfiguracao` e devolve o diretório; um objeto forjado { diretorio } ou um texto é recusado (IMAGENS_INDISPONIVEL); sem a variável o diretório é null. Ressalva: `lerConfiguracao` aceita qualquer objeto tipo ambiente, então isso prova a FORMA da configuração, não que ela veio do ambiente real', async () => {
    const c = await cenario();
    assert.equal(exigirDiretorio(c.config), c.dirOrigem);
    for (const forjada of [{ diretorio: c.dirOrigem }, c.dirOrigem, null, undefined, { ...c.config }]) assert.throws(() => exigirDiretorio(forjada), (e) => e.codigo === 'IMAGENS_INDISPONIVEL');
    assert.equal(lerConfiguracao({}).diretorio, null);
    const antes = c.config.diretorio;
    c.ambiente.IMAGENS_ARMAZENAMENTO_DIRETORIO = path.join(c.raiz, 'outro');
    assert.equal(exigirDiretorio(c.config), antes, 'a configuração produzida é um instantâneo: mudar o ambiente depois não a altera');
  });

  teste('CTL-02 — a configuração recusa diretório relativo, não canônico ou raiz do sistema (IMAGENS_DIRETORIO_INVALIDO), sem ecoar o valor', () => {
    for (const ruim of ['relativo/dir', '/tmp/../tmp/x', '/', '/tmp//x']) {
      assert.throws(() => lerConfiguracao({ IMAGENS_ARMAZENAMENTO_DIRETORIO: ruim }), (e) => e.codigo === 'IMAGENS_DIRETORIO_INVALIDO' && !String(e.message).includes(ruim));
    }
  });

  teste('CTL-03 — a aquisição exclusiva é do filesystem: `mkdir` NÃO recursivo falha com EEXIST em entrada existente (inclusive vazia) e, em disputa de promessas, só uma vence; com `recursive: true` a existente passa em silêncio (por isso NÃO se usa); isso vale no filesystem local deste processo, não prova nada entre processos', async () => {
    const raiz = novaRaiz();
    const alvo = path.join(raiz, 'p');
    const resultados = await Promise.allSettled([fsp.mkdir(alvo, { mode: 0o700 }), fsp.mkdir(alvo, { mode: 0o700 }), fsp.mkdir(alvo, { mode: 0o700 })]);
    assert.equal(resultados.filter((r) => r.status === 'fulfilled').length, 1);
    for (const r of resultados.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'EEXIST');
    await assert.doesNotReject(fsp.mkdir(alvo, { recursive: true }), 'recursive aceitaria a entrada existente');
    assert.throws(() => fs.mkdirSync(alvo), (e) => e.code === 'EEXIST');
  });

  teste('CTL-04 — a fábrica do armazenamento CRIA o diretório informado se ele não existir: por isso a origem deve ser validada como EXISTENTE antes de qualquer fábrica, e a preparação só é criada pela aquisição exclusiva', async () => {
    const raiz = novaRaiz();
    const ausente = path.join(raiz, 'nao-existia');
    assert.equal(fs.existsSync(ausente), false);
    criarArmazenamentoImagens({ diretorio: ausente });
    assert.equal(fs.statSync(ausente).isDirectory(), true);
  });

  teste('CTL-05 — a montagem aprovada exige `preparacao` EXISTENTE e produz o layout `<prep>/imagens` + `<prep>/manifesto.*`, mas NÃO compara origem e preparação: uma origem enraizada no PAI das preparações (ancestral) é aceita sem queixa; a camada nova precisa preencher essa lacuna', async () => {
    const c = await cenario();
    const preparacao = path.join(c.pai, 'prep-existente');
    fs.mkdirSync(preparacao, { mode: 0o700 });
    const origemAncestral = criarArmazenamentoImagens({ diretorio: c.pai });
    const m = criarMontagemDeDestinoConfiavel({ preparacao, origem: origemAncestral, conjuntoId: CONJUNTO, maxBytesPorArquivo: 4096 });
    assert.deepEqual(Object.keys(m).sort(), ['compor', 'obterVerificacao']);
    assert.equal(fs.statSync(path.join(preparacao, 'imagens')).isDirectory(), true);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- ISO-02
describe('[ISO-02] proveniência da origem (PROVEDOR SIMULADO: ambiente da fixture + `lerConfiguracao` real)', () => {
  teste('ISO-02a — a origem não é entregue por consumidor: capacidade com `abrir()` (`origem`), caminho declarado, `preparacao`, `destino`, `area`, `copiar`, `verificador`, `armazenamento`, chave desconhecida, configuração FORJADA ({ diretorio }), texto e configuração sem diretório são PARAMETROS_INVALIDOS, sem criar nada em disco', async () => {
    const c = await cenario();
    const antes = arvore(c.raiz);
    const casos = [
      ['capacidade `origem` com abrir()', { origem: c.origemReal }], ['caminho `origem`', { origem: c.dirOrigem }], ['`preparacao` declarada', { preparacao: path.join(c.pai, 'x') }], ['`destino`', { destino: c.origemReal }],
      ['`area`', { area: c.pai }], ['`copiar`', { copiar: async () => ({}) }], ['`verificador`', { verificador: { verificar: async () => ({}) } }], ['`armazenamento`', { armazenamento: c.origemReal }], ['chave desconhecida', { extra: 1 }],
      ['configuração forjada', { configuracaoDeImagens: { diretorio: c.dirOrigem } }], ['configuração é texto', { configuracaoDeImagens: c.dirOrigem }], ['configuração é a própria capacidade', { configuracaoDeImagens: c.origemReal }],
      ['configuração sem diretório (recurso indisponível)', { configuracaoDeImagens: lerConfiguracao({}) }], ['conjuntoId não é string', { conjuntoId: 5 }], ['limite inválido', { maxBytesPorArquivo: 0 }], ['selagem sem funções', { selagem: {} }],
    ];
    for (const [rotulo, extras] of casos) await recusa(adquirir(c, extras), 'PARAMETROS_INVALIDOS', c, rotulo);
    for (const ruim of [null, 'x', [], undefined, {}]) await recusa(modulo().adquirirPreparacaoExclusiva(ruim), 'PARAMETROS_INVALIDOS', c, String(ruim));
    assert.deepEqual(arvore(c.raiz), antes, 'nenhuma recusa tocou o disco');
  });

  teste('ISO-02b — origem inexistente, arquivo no lugar do diretório ou não diretório: ORIGEM_INVALIDA, e a origem inexistente NÃO é criada (a fábrica do armazenamento a criaria); nenhuma preparação é adquirida', async () => {
    const c = await cenario();
    const ausente = path.join(c.raiz, 'origem-ausente');
    const arquivo = path.join(c.raiz, 'origem-arquivo');
    fs.writeFileSync(arquivo, 'x');
    const antes = arvore(c.raiz);
    await recusa(adquirir(c, { configuracaoDeImagens: configDe(ausente) }), 'ORIGEM_INVALIDA', c, 'inexistente');
    await recusa(adquirir(c, { configuracaoDeImagens: configDe(arquivo) }), 'ORIGEM_INVALIDA', c, 'arquivo');
    assert.equal(fs.existsSync(ausente), false);
    assert.deepEqual(arvore(c.raiz), antes);
    assert.deepEqual(fs.readdirSync(c.pai), []);
  });

  teste('ISO-02c — a origem usada é a da CONFIGURAÇÃO verificada: as imagens copiadas vêm do diretório configurado (e não de uma isca por perto) e mudar o ambiente da fixture depois da obtenção da configuração não troca a origem; o consumidor nunca recebe capacidade ou caminho', async () => {
    const c = await cenario();
    const isca = path.join(c.raiz, 'isca');
    const iscaStorage = criarArmazenamentoImagens({ diretorio: isca });
    await iscaStorage.gravar(c.plano[0].chave, Buffer.from('conteudo-de-isca'), { maxBytes: 4096 });
    const m = await adquirir(c);
    c.ambiente.IMAGENS_ARMAZENAMENTO_DIRETORIO = isca; // substituição depois da validação: sem efeito
    const r = await m.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.equal(r.ok, true);
    for (const item of c.plano) assert.equal(sha(fs.readFileSync(path.join(c.pai, 'prep-1', 'imagens', item.chave))), item.sha256);
    assert.deepEqual(Object.keys(m).sort(), ['compor', 'obterVerificacao']);
    semVazamento(r, c);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- ISO-03
describe('[ISO-03] separação física entre origem e preparação, estabelecida ANTES de qualquer cópia', () => {
  teste('ISO-03a — sobreposição detectável: origem IGUAL à preparação prospectiva, origem ANCESTRAL (o próprio pai e o diretório acima dele), preparação que CONTÉM a origem e origem alcançada por link simbólico (alias canônico) são ORIGEM_SOBREPOSTA; nada é criado nem removido', async () => {
    const c = await cenario();
    const igual = path.join(c.pai, 'igual');
    fs.mkdirSync(igual, { mode: 0o700 });
    const dentro = path.join(c.pai, 'contem', 'origem-dentro');
    fs.mkdirSync(dentro, { recursive: true, mode: 0o700 });
    const alias = path.join(c.raiz, 'alias-do-pai');
    fs.symlinkSync(c.pai, alias);
    const antes = arvore(c.raiz);
    const casos = [
      ['origem igual', { configuracaoDeImagens: configDe(igual), nomeDaPreparacao: 'igual' }],
      ['origem = o pai (ancestral)', { configuracaoDeImagens: configDe(c.pai) }],
      ['origem acima do pai (ancestral)', { configuracaoDeImagens: configDe(c.raiz) }],
      ['preparação contém a origem', { configuracaoDeImagens: configDe(dentro), nomeDaPreparacao: 'contem' }],
      ['alias canônico do pai por link simbólico', { configuracaoDeImagens: configDe(alias) }],
    ];
    for (const [rotulo, extras] of casos) await recusa(adquirir(c, extras), 'ORIGEM_SOBREPOSTA', c, rotulo);
    assert.deepEqual(arvore(c.raiz), antes, 'a separação foi decidida antes de qualquer criação');
  });

  teste('ISO-03b — SEM falso positivo: diretórios distintos com PREFIXO TEXTUAL semelhante não se sobrepõem (origem `dados` com pai `dados-backup`; origem `<pai>/prep` com preparação `prep2`); a comparação é por componentes, não por `startsWith`', async () => {
    const c = await cenario({ nomeOrigem: 'dados', nomePai: 'dados-backup' });
    const m1 = await adquirir(c);
    assert.equal((await m1.compor({ contexto: c.contexto, dump: DUMP_FICTICIO })).ok, true);

    const d = await cenario();
    const irma = path.join(d.pai, 'prep');
    fs.mkdirSync(irma, { mode: 0o700 }); // irmã da preparação futura, dentro do mesmo pai
    const m2 = await adquirir(d, { configuracaoDeImagens: configDe(irma), nomeDaPreparacao: 'prep2' });
    assert.deepEqual(Object.keys(m2).sort(), ['compor', 'obterVerificacao']);
    assert.equal(fs.statSync(path.join(d.pai, 'prep2')).isDirectory(), true);
  });

  teste('ISO-03c — `diretorioPai` e `nomeDaPreparacao` controlados: pai relativo, com `..`, NUL, inexistente, arquivo ou link simbólico; nome com separadores, `.`, `..`, vazio, longo demais ou absoluto: recusa antes de qualquer criação (sem componentes arbitrários de caminho)', async () => {
    const c = await cenario();
    const arquivo = path.join(c.raiz, 'pai-arquivo');
    fs.writeFileSync(arquivo, 'x');
    const ligacao = path.join(c.raiz, 'pai-ligacao');
    fs.symlinkSync(c.pai, ligacao);
    const antes = arvore(c.raiz);
    const casos = [
      ['pai relativo', { diretorioPai: 'relativo/pai' }], ['pai com ..', { diretorioPai: `${c.pai}/../preparacoes` }], ['pai com NUL', { diretorioPai: `${c.pai}\0x` }], ['pai inexistente', { diretorioPai: path.join(c.raiz, 'pai-ausente') }],
      ['pai é arquivo', { diretorioPai: arquivo }], ['pai é link simbólico', { diretorioPai: ligacao }], ['pai não é string', { diretorioPai: 123 }],
      ['nome com barra', { nomeDaPreparacao: 'a/b' }], ['nome com ..', { nomeDaPreparacao: '..' }], ['nome .', { nomeDaPreparacao: '.' }], ['nome vazio', { nomeDaPreparacao: '' }], ['nome absoluto', { nomeDaPreparacao: '/abs' }],
      ['nome com travessia', { nomeDaPreparacao: '../fora' }], ['nome longo demais', { nomeDaPreparacao: 'a'.repeat(101) }], ['nome não é string', { nomeDaPreparacao: 7 }],
    ];
    for (const [rotulo, extras] of casos) await recusa(adquirir(c, extras), 'PARAMETROS_INVALIDOS', c, rotulo);
    assert.deepEqual(arvore(c.raiz), antes);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- ISO-04 / ISO-05
describe('[ISO-04 / ISO-05] aquisição exclusiva e não reutilização', () => {
  teste('ISO-04 — a aquisição cria a preparação NOVA por `mkdir` exclusivo: antes da aquisição nada existe; depois existe só `<pai>/<nome>` (e o `imagens` da montagem); a preparação NUNCA é criada por um pai que ainda não existe (sem `recursive`)', async () => {
    const c = await cenario();
    assert.deepEqual(fs.readdirSync(c.pai), []);
    const m = await adquirir(c);
    assert.deepEqual(fs.readdirSync(c.pai), ['prep-1']);
    assert.deepEqual(fs.readdirSync(path.join(c.pai, 'prep-1')), ['imagens']);
    assert.equal(fs.statSync(path.join(c.pai, 'prep-1')).mode & 0o777, 0o700);
    assert.equal(m.obterVerificacao(), null);
  });

  teste('ISO-05 — NÃO REUTILIZAÇÃO: preparação existente vazia, com imagens residuais, com manifesto anterior, de operação incompleta ou já usada com sucesso é PREPARACAO_EXISTENTE; o conteúdo existente fica IDÊNTICO (nenhuma limpeza, adoção ou sobrescrita)', async () => {
    const c = await cenario();
    const casos = {
      vazia: () => {},
      comImagensResiduais: (p) => { fs.mkdirSync(path.join(p, 'imagens', 'padrao'), { recursive: true }); fs.writeFileSync(path.join(p, 'imagens', 'padrao', 'residuo.bin'), 'residuo'); },
      comManifestoAnterior: (p) => { fs.writeFileSync(path.join(p, 'manifesto.json'), '{}'); fs.writeFileSync(path.join(p, 'manifesto.sha256'), 'x'); },
      incompleta: (p) => { fs.mkdirSync(path.join(p, 'imagens'), { recursive: true }); fs.writeFileSync(path.join(p, 'parcial.tmp'), 'parcial'); },
    };
    for (const [nome, preparar] of Object.entries(casos)) {
      const p = path.join(c.pai, nome);
      fs.mkdirSync(p, { mode: 0o700 });
      preparar(p);
    }
    const jaUsada = await adquirir(c, { nomeDaPreparacao: 'ja-usada' });
    assert.equal((await jaUsada.compor({ contexto: c.contexto, dump: DUMP_FICTICIO })).ok, true);
    const antes = arvore(c.raiz);
    const conteudoAntes = antes.map((n) => { const q = path.join(c.raiz, n); return fs.lstatSync(q).isFile() ? sha(fs.readFileSync(q)) : 'dir'; });
    for (const nome of [...Object.keys(casos), 'ja-usada']) await recusa(adquirir(c, { nomeDaPreparacao: nome }), 'PREPARACAO_EXISTENTE', c, nome);
    assert.deepEqual(arvore(c.raiz), antes);
    assert.deepEqual(arvore(c.raiz).map((n) => { const q = path.join(c.raiz, n); return fs.lstatSync(q).isFile() ? sha(fs.readFileSync(q)) : 'dir'; }), conteudoAntes);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- ISO-06 / ISO-07
describe('[ISO-06 / ISO-07] disputa pela aquisição e isolamento entre operações', () => {
  teste('ISO-06 — DISPUTA REAL: várias aquisições simultâneas (promessas iniciadas juntas, `mkdir` assíncrono) do MESMO nome: exatamente uma vence e as outras são PREPARACAO_EXISTENTE; o vencedor continua utilizável depois (as perdedoras não removem nem alteram nada) e não há montagem dupla. Limite: mesmo processo, filesystem local', async () => {
    const c = await cenario();
    for (let rodada = 0; rodada < 6; rodada += 1) {
      const nome = `corrida-${rodada}`;
      const resultados = await Promise.allSettled([adquirir(c, { nomeDaPreparacao: nome }), adquirir(c, { nomeDaPreparacao: nome }), adquirir(c, { nomeDaPreparacao: nome }), adquirir(c, { nomeDaPreparacao: nome })]);
      const vencedoras = resultados.filter((r) => r.status === 'fulfilled');
      assert.equal(vencedoras.length, 1, `rodada ${rodada}`);
      for (const r of resultados.filter((x) => x.status === 'rejected')) assert.equal(r.reason.code, 'PREPARACAO_EXISTENTE');
      assert.equal(fs.readdirSync(c.pai).filter((n) => n === nome).length, 1);
      const r = await vencedoras[0].value.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
      assert.equal(r.ok, true, 'o vencedor segue íntegro');
      assert.deepEqual(fs.readdirSync(path.join(c.pai, nome)).sort(), ['imagens', 'manifesto.json', 'manifesto.sha256']);
    }
  });

  teste('ISO-07 — OPERAÇÕES INDEPENDENTES (mesma origem configurada, preparações distintas): destinos, manifestos e diagnósticos separados; alterar uma não afeta a outra; hashes iguais não as tornam a mesma; cada montagem tem consumo único próprio', async () => {
    const c = await cenario();
    const [a, b] = await Promise.all([adquirir(c, { nomeDaPreparacao: 'op-a' }), adquirir(c, { nomeDaPreparacao: 'op-b', conjuntoId: 'conjunto-iso-0002' })]);
    const [ra, rb] = await Promise.all([a.compor({ contexto: c.contexto, dump: DUMP_FICTICIO }), b.compor({ contexto: c.contexto, dump: DUMP_FICTICIO })]);
    assert.equal(ra.ok, true);
    assert.equal(rb.ok, true);
    assert.notEqual(ra.identidade.sha256Manifesto, rb.identidade.sha256Manifesto);
    assert.equal(ra.identidade.conjuntoId, CONJUNTO);
    assert.equal(rb.identidade.conjuntoId, 'conjunto-iso-0002');
    const mestreA = path.join(c.pai, 'op-a', 'imagens', c.plano[0].chave);
    const mestreB = path.join(c.pai, 'op-b', 'imagens', c.plano[0].chave);
    assert.notEqual(fs.statSync(mestreA).ino, fs.statSync(mestreB).ino);
    fs.appendFileSync(mestreA, Buffer.from('x'));
    assert.equal(sha(fs.readFileSync(mestreB)), c.plano[0].sha256);
    assert.equal(a.obterVerificacao().classe, 'INTEGRA');
    assert.equal(b.obterVerificacao().classe, 'INTEGRA');
    assert.notEqual(a.obterVerificacao(), b.obterVerificacao());
    const segunda = await a.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.deepEqual({ ...segunda.falha }, { estagio: 'COPIA', codigo: 'COPIA_FALHOU' });
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- ISO-08 / ISO-09
describe('[ISO-08 / ISO-09] falhas, efeitos colaterais e integração com a montagem existente', () => {
  teste('ISO-08a — falha do filesystem NA AQUISIÇÃO (pai sem permissão de escrita): AQUISICAO_FALHOU, sem eco; nenhuma preparação nem artefato criado; depois de restaurada a permissão uma nova tentativa adquire normalmente (nada ficou reservado)', async () => {
    const c = await cenario();
    fs.chmodSync(c.pai, 0o500);
    try { await recusa(adquirir(c), 'AQUISICAO_FALHOU', c, 'pai sem escrita'); } finally { fs.chmodSync(c.pai, 0o700); }
    assert.deepEqual(fs.readdirSync(c.pai), []);
    assert.deepEqual(Object.keys(await adquirir(c)).sort(), ['compor', 'obterVerificacao']);
  }, { skip: SEM_PERMISSAO });

  teste('ISO-09 — INTEGRAÇÃO com a montagem existente e LAYOUT: a camada devolve a mesma forma pública da montagem; o fluxo completo copia da origem configurada, verifica fisicamente, constrói o manifesto e sela em `<pai>/<nome>`; imagens só em `imagens/`, manifesto só no nível da preparação; nada de caminho, origem ou armazenamento no resultado nem no diagnóstico', async () => {
    const c = await cenario();
    const m = await adquirir(c);
    assert.equal(Object.isFrozen(m), true);
    assert.deepEqual(Object.keys(m).sort(), ['compor', 'obterVerificacao']);
    const r = await m.compor({ contexto: c.contexto, dump: DUMP_FICTICIO });
    assert.equal(r.ok, true);
    assert.equal(r.selado, true);
    assert.equal(r.arquivos, 8);
    assert.deepEqual(fs.readdirSync(path.join(c.pai, 'prep-1')).sort(), ['imagens', 'manifesto.json', 'manifesto.sha256']);
    assert.equal(fs.readdirSync(path.join(c.pai, 'prep-1', 'imagens')).some((n) => n.startsWith('manifesto')), false);
    assert.equal(m.obterVerificacao().classe, 'INTEGRA');
    for (const valor of [r, m.obterVerificacao()]) {
      semVazamento(valor, c);
      const texto = JSON.stringify(valor).toLowerCase();
      for (const proibida of ['"valido"', 'recuper', 'publicad', 'restaur', 'veredito']) assert.equal(texto.includes(proibida), false, proibida);
    }
    for (const capacidade of ['gravar', 'remover', 'removerVariantes', 'abrir', 'existe', 'listar', 'chaveDe', 'destino', 'origem', 'armazenamento']) assert.equal(Object.hasOwn(m, capacidade), false, capacidade);
  });
});

// ------------------------------------------------------------------------------------------------------------------------------- ISO-10
describe('[ISO-10] limites e pendências (registrados; nada foi implementado para eliminá-los)', () => {
  const todo = (nome, motivo) => test(nome, { todo: motivo }, () => {});
  todo('ISO-10a — PROVENIÊNCIA REAL: os testes usam um ambiente SIMULADO com `lerConfiguracao` real; a configuração do ambiente real da aplicação não é comprovada, e `lerConfiguracao` aceita qualquer objeto tipo ambiente (prova a forma, não a fonte)', 'provedor simulado');
  todo('ISO-10b — CONFIGURAÇÃO DO DIRETÓRIO-PAI das preparações: não existe variável de ambiente nem provedor para ele; hoje é parâmetro de um chamador confiável; definir configuração própria (no padrão `lerConfiguracao`) é incremento separado', 'lacuna de configuração');
  todo('ISO-10c — FALHA DEPOIS DA AQUISIÇÃO (por exemplo, a montagem recusar um parâmetro tardio) deixa a preparação reservada sem limpeza: não há como induzi-la sem uma abertura de teste na interface; fica registrada, e a política de preparações abandonadas (inventário, retenção, remoção por quem comprovadamente as criou) é incremento próprio', 'sem ponto de injeção seguro');
  todo('ISO-10d — TOCTOU: a comparação de caminhos é pontual; troca de diretórios ou do alvo de links depois da validação, outros escritores, aliases não detectáveis pelos contratos atuais e identidade física contínua (`dev`/`ino`) não são garantidos; a aquisição atômica não resolve isso', 'limite da plataforma');
  todo('ISO-10e — a atomicidade de `mkdir` aqui é a do filesystem LOCAL e foi exercitada só entre promessas do mesmo processo; resistência entre processos/máquinas, sistemas de arquivos de rede ou S3 e durabilidade após falha do sistema não são provadas', 'limite da prova');
  todo('ISO-10f — cancelamento seguro de operação pendente, recuperação após interrupção, imutabilidade depois da verificação, evidência física do `pg_dump`, autenticidade, publicação e restauração: fora do alcance', 'bloqueio operacional');
  todo('VF09-11 — UMA fábrica de armazenamento por montagem continua garantia por construção (inspeção do código), não observada por teste; esta camada não a resolve', 'preservado da suíte anterior');
});
