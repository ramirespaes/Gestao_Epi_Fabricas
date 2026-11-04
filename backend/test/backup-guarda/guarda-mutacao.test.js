'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * P2 — prova de eficácia da guarda (G11): árvore sintética INTEIRAMENTE EM MEMÓRIA, catálogo e listas sintéticos. O controle sem
 * mutação passa; cada mutação M01–M14 (e as extras) faz a guarda falhar PELA REGRA ESPERADA, nunca por erro incidental. Nenhum
 * arquivo real é lido, criado ou alterado.
 */

const G = () => require('../helpers/backup-guarda-analise');
const R = () => exigirModulo('src/services/backup-fontes-regras.service');

const HEX = 'b'.repeat(64);
// Registro de aprovação FICTÍCIO e isolado (só para provar o contrato de rastreabilidade); nenhuma entrada real o usa.
const DOC_APROVACAO = '# Aprovação sintética da linha de base\nref: GATE-P2-2026-11-01\nassinatura: fictícia, só para teste.\n';
const REF_APROVACAO = 'GATE-P2-2026-11-01';
const REGEX_IMAGEM = () => `/${R().FORMATOS_DE_CHAVE['imagem-v1'].source}/`;
const componente = (nome) => ({ estado: 'PRESENTE', modulo: `src/services/sint-${nome}.service.js`, teste: `test/services/sint-${nome}.test.js` });

function catalogoSintetico() {
  const base = {
    decisaoPendente: null, recomendacao: null, decisaoRef: null, justificativa: null, relevancia: null, persistenciaFisica: null, riscoResidual: null,
    categoriaDeSegredo: null, recuperacao: null, responsavel: 'MODULO_SINTETICO', aprovador: 'AUTORIDADE_DO_PROJETO',
    raiz: { variavel: null }, chave: { formatoChaveId: null }, verificadorId: null, escopo: { tipo: 'GLOBAL', regraEmpresa: null }, referencias: [],
    mutabilidade: 'IMUTAVEL_POR_CONTEUDO', sensibilidade: 'INTERNO', remocao: { fisica: 'NENHUMA', janela: 'NAO_APLICAVEL' },
    componentes: { planejador: { estado: 'AUSENTE', modulo: null, teste: null }, copiador: { estado: 'AUSENTE', modulo: null, teste: null }, verificador: { estado: 'AUSENTE', modulo: null, teste: null }, restaurador: { estado: 'AUSENTE', modulo: null, teste: null } },
    reconstrucao: null, promocao: null, suspensao: null, versaoContrato: 1,
  };
  return {
    versao: 1,
    fontes: [
      {
        ...base, id: 'arquivos-sint', tipo: 'ARQUIVOS', classe: 'PROTEGIDA', raiz: { variavel: 'SINT_ARQUIVOS_DIRETORIO' }, chave: { formatoChaveId: 'imagem-v1' },
        verificadorId: 'imagens-consistencia-v1', escopo: { tipo: 'EMPRESA', regraEmpresa: 'SEGMENTO_INICIAL_DA_CHAVE' },
        referencias: [{ tabela: 'arquivos_sint', colunas: ['empresa_id', 'sha256'] }], remocao: { fisica: 'JANELA_LIMPEZA', janela: 'UNICA' },
        componentes: { planejador: componente('planejador'), copiador: componente('copiador'), verificador: componente('verificador'), restaurador: componente('restaurador') },
      },
      {
        ...base, id: 'pendente-sint', tipo: 'ARQUIVOS', classe: null, decisaoPendente: 'D-F1', recomendacao: 'PROTEGIDA', relevancia: 'PERSISTENTE_RELEVANTE',
        persistenciaFisica: 'SIM', riscoResidual: 'DADO_PESSOAL', raiz: { variavel: 'SINT_PENDENTE_DIRETORIO' }, sensibilidade: 'PESSOAL',
      },
      {
        ...base, id: 'efemera-sint', tipo: 'ARQUIVOS', classe: 'EFEMERA', decisaoRef: 'P0-CF-1', justificativa: 'Coordenação sintética; não copiar nem restaurar.',
        relevancia: 'NAO_PERSISTENTE', persistenciaFisica: 'SIM', riscoResidual: 'TRAVA_OBSOLETA_BLOQUEIA_OPERACAO', raiz: { variavel: 'SINT_JANELA_ARQUIVO' }, mutabilidade: 'MUTAVEL',
      },
    ],
  };
}

function arvoreSintetica() {
  const cfgEmail = [
    "'use strict';",
    "const MENSAGENS = { SO_SMTP_EM_PRODUCAO: 'em production só o modo smtp é aceito' };",
    'function validar(e, producao, problema) {',
    "  if (producao && e.EMAIL_MODO !== 'smtp') { problema('EMAIL_MODO', MENSAGENS.SO_SMTP_EM_PRODUCAO); return; }",
    '}',
    'module.exports = { validar };',
  ].join('\n');
  const dump = [
    "'use strict';",
    'const ARGUMENTOS_FECHADOS = [',
    '  /^--format=custom$/,',
    '  /^--no-password$/,',
    '  /^--snapshot=[0-9A-F]{8}-[0-9A-F]{8}-[1-9][0-9]{0,9}$/,',
    '  /^--dbname=[A-Za-z0-9_][A-Za-z0-9_.-]{0,62}$/,',
    '];',
    'module.exports = { ARGUMENTOS_FECHADOS };',
  ].join('\n');
  const armazenamento = [
    "'use strict';",
    "const fsp = require('node:fs/promises');",
    `const CHAVE = ${REGEX_IMAGEM()};`,
    '// writeFile( em comentário de linha não conta',
    '/* unlink( em comentário de bloco não conta */',
    'async function gravar(a, b) { await fsp.mkdir(a); await fsp.writeFile(b, ""); }',
    'async function remover(a) { await fsp.unlink(a); }',
    'module.exports = { gravar, remover, chaveDe };',
    'function chaveDe() { return CHAVE; }',
  ].join('\n');
  const mapa = new Map([
    ['.env.example', '# raízes\nSINT_ARQUIVOS_DIRETORIO=\nSINT_PENDENTE_DIRETORIO=\nSINT_JANELA_ARQUIVO=\nSINT_CONSTANTE_DIRETORIO=\n'],
    ['src/config/sint.js', "const VARIAVEL = 'SINT_ARQUIVOS_DIRETORIO';\nconst OUTRA = 'SINT_PENDENTE_DIRETORIO';\nconst J = 'SINT_JANELA_ARQUIVO';\nmodule.exports = { VARIAVEL, OUTRA, J };\n"],
    ['src/config/email.js', cfgEmail],
    ['src/services/imagem-backup-pgdump-lancador.service.js', dump],
    ['src/storage/sint-armazenamento.js', armazenamento],
    ['src/services/sint-planejador.service.js', 'module.exports = {};\n'],
    ['src/services/sint-copiador.service.js', 'module.exports = {};\n'],
    ['src/services/sint-verificador.service.js', 'module.exports = {};\n'],
    ['src/services/sint-restaurador.service.js', 'module.exports = {};\n'],
    ['src/routes/sint.routes.js', "router.post('/x', conteudo('image/*'), ctrl);\n"],
    ['test/services/sint-planejador.test.js', ''],
    ['test/services/sint-copiador.test.js', ''],
    ['test/services/sint-verificador.test.js', ''],
    ['test/services/sint-restaurador.test.js', ''],
    ['test/config/email.test.js', "assert.match(erroDe({ NODE_ENV: 'production', EMAIL_MODO: 'arquivo' }), esperado);\n"],
    ['test/app-producao-email.test.js', "['EMAIL_MODO=arquivo', { EMAIL_MODO: 'arquivo' }],\n"],
    ['migrations/001_sint.sql', `-- sha256 em comentário não conta\nCREATE TABLE arquivos_sint (\n  empresa_id INTEGER NOT NULL,\n  sha256 CHAR(64) NOT NULL\n);\n`],
    ['package.json', JSON.stringify({ name: 'sint', dependencies: { express: '5.0.0', sharp: '0.33.0' }, devDependencies: { supertest: '7.0.0' } })],
    ['docs/aprovacao-sint.md', DOC_APROVACAO],
  ]);
  return mapa;
}

function listasSinteticas() {
  const aprovada = { revisaoHumana: 'APROVADA', aprovadoEm: '2026-11-01', aprovacaoRef: REF_APROVACAO };
  return {
    ESCRITORES_CONHECIDOS: {
      'src/storage/sint-armazenamento.js': { classificacao: 'FONTE', fonteId: 'arquivos-sint', justificativa: 'Armazenamento oficial sintético.', ocorrencias: { escrita: { mkdir: 1, writefile: 1 }, remocao: { unlink: 1 } }, ...aprovada },
    },
    ROTAS_BINARIAS_CONHECIDAS: {
      'src/routes/sint.routes.js': { classificacao: 'ENTRADA_BINARIA', fonteId: 'arquivos-sint', justificativa: 'Entrada de imagem sintética.', ocorrencias: { 'image/*': 1 }, ...aprovada },
    },
    MIGRATIONS_CONHECIDAS: {
      // Dois sinais: a coluna `sha256` e o nome da tabela `arquivos_sint` (o padrão `arquivo*` casa de propósito; a revisão humana decide).
      'migrations/001_sint.sql': { classificacao: 'FONTE', fonteId: 'arquivos-sint', justificativa: 'Tabela de referência sintética.', ocorrencias: { sha256: 1, arquivos_sint: 1 }, ...aprovada },
    },
    DEPENDENCIAS_REVISADAS: {
      express: { classificacao: 'SEM_RELACAO_COM_ARMAZENAMENTO', justificativa: 'Servidor HTTP sintético.', ...aprovada },
      sharp: { classificacao: 'PROCESSAMENTO_SEM_PERSISTENCIA', justificativa: 'Processamento sintético.', ...aprovada },
      supertest: { classificacao: 'FERRAMENTA_DE_DESENVOLVIMENTO', justificativa: 'Teste HTTP sintético.', ...aprovada },
    },
    SUPERFICIE_ESPERADA: {
      'arquivos-sint': { modulo: 'src/storage/sint-armazenamento.js', exportsEsperados: ['gravar', 'remover', 'chaveDe'], regexChave: 'imagem-v1', variavel: 'SINT_ARQUIVOS_DIRETORIO', arquivoDeConfig: 'src/config/sint.js', versaoContrato: 1 },
    },
    NOMES_QUE_NAO_SAO_RAIZ: [{ nome: 'SINT_CONSTANTE_DIRETORIO', arquivo: '.env.example', ocorrencias: 1 }],
    APROVACOES: [{ ref: REF_APROVACAO, documento: 'docs/aprovacao-sint.md', sha256: G().sha256(DOC_APROVACAO) }],
    minimoDeArquivos: 10,
  };
}

const analisar = ({ arvore = arvoreSintetica(), catalogo = catalogoSintetico(), listas = listasSinteticas() } = {}) => G().analisarArvore(G().provedorEmMemoria(arvore), catalogo, listas);
const regrasViolidas = (r) => [...new Set(r.violacoes.map((v) => v.regra))].sort();
const codigos = (r) => r.violacoes.map((v) => v.codigo);
const semErroInterno = (r) => assert.ok(!codigos(r).some((c) => c === 'ERRO_INTERNO_DO_DETECTOR' || c === 'FALHA_DE_LEITURA'), `erro incidental: ${JSON.stringify(r.violacoes)}`);

describe('S7 — controle: árvore sintética sem violações passa', () => {
  test('controle verde, todas as regras executadas, inventário produzido e sem conteúdo de linha', () => {
    const r = analisar();
    assert.deepEqual(r.violacoes, [], JSON.stringify(r.violacoes));
    assert.equal(r.aprovado, true);
    assert.deepEqual(r.regrasExecutadas, G().REGRAS);
    assert.equal(r.varridos, arvoreSintetica().size);
    assert.ok(r.ocorrencias.length >= 8);
    assert.ok(r.ocorrencias.every((o) => /^OC-\d{4}$/.test(o.id) && typeof o.regra === 'string' && o.classificacao !== 'NAO_CLASSIFICADA'));
    const texto = JSON.stringify(r);
    assert.ok(!texto.includes('fsp.writeFile(b') && !texto.includes('CREATE TABLE'), 'nenhum conteúdo de linha na saída');
    assert.ok(Object.isFrozen(r) && Object.isFrozen(r.violacoes));
    assert.ok(r.informativos.some((i) => i.codigo === 'G8_FONTE_PENDENTE_DE_DECISAO'));
  });

  test('comentários de linha e de bloco não contam como escrita/remoção', () => {
    const r = analisar();
    const arm = r.ocorrencias.filter((o) => o.arquivo === 'src/storage/sint-armazenamento.js' && ['G2', 'G3'].includes(o.regra));
    assert.deepEqual(arm.map((o) => [o.regra, o.linha, o.sinal]), [['G2', 6, 'mkdir'], ['G2', 6, 'writefile'], ['G3', 7, 'unlink']]);
  });
});

describe('S9 — mutações M01 a M14: cada uma reprova pela regra esperada', () => {
  const casos = [
    ['M01', 'remover uma fonte do catálogo cuja raiz continua configurada', 'G1', ({ catalogo }) => { catalogo.fontes = catalogo.fontes.filter((f) => f.id !== 'pendente-sint'); }],
    ['M02', 'variável *_DIRETORIO nova no .env.example', 'G1', ({ arvore }) => { arvore.set('.env.example', `${arvore.get('.env.example')}NOVA_RAIZ_DIRETORIO=\n`); }],
    ['M03', 'createWriteStream num arquivo novo', 'G2', ({ arvore }) => { arvore.set('src/services/novo.service.js', "const fs = require('node:fs');\nfs.createWriteStream('x');\n"); }],
    ['M04', 'escrita a mais num escritor conhecido', 'G4', ({ arvore }) => { arvore.set('src/storage/sint-armazenamento.js', `${arvore.get('src/storage/sint-armazenamento.js')}\nasync function extra(c) { await fsp.appendFile(c, ''); }\n`); }],
    ['M05', 'unlink num arquivo novo', 'G3', ({ arvore }) => { arvore.set('scripts/limpar.js', "const fsp = require('node:fs/promises');\nfsp.unlink('x');\n"); }],
    ['M06', 'migration com chave_armazenamento sem mapeamento', 'G5', ({ arvore }) => { arvore.set('migrations/002_sint.sql', 'ALTER TABLE x ADD COLUMN chave_armazenamento VARCHAR(80);\n'); }],
    ['M07', 'multer adicionado às dependências', 'G6', ({ arvore }) => { const p = JSON.parse(arvore.get('package.json')); p.dependencies.multer = '1.4.5'; arvore.set('package.json', JSON.stringify(p)); }],
    ['M08', 'rota nova com express.raw', 'G7', ({ arvore }) => { arvore.set('src/routes/anexos.routes.js', "router.post('/a', express.raw({ type: 'application/octet-stream' }), c);\n"); }],
    ['M09', 'classe nula sem decisão pendente', 'G8', ({ catalogo }) => { catalogo.fontes[1].decisaoPendente = null; }],
    ['M10', 'módulo declarado como componente apagado', 'G9', ({ arvore }) => { arvore.delete('src/services/sint-verificador.service.js'); }],
    ['M11', '--schema acrescentado aos args do pg_dump', 'G13', ({ arvore }) => { arvore.set('src/services/imagem-backup-pgdump-lancador.service.js', arvore.get('src/services/imagem-backup-pgdump-lancador.service.js').replace("/^--no-password$/,", "/^--no-password$/,\n  /^--schema=public$/,")); }],
    ['M12', 'recusa do modo arquivo em produção removida', 'G12', ({ arvore }) => { arvore.set('src/config/email.js', arvore.get('src/config/email.js').replace("if (producao && e.EMAIL_MODO !== 'smtp') { problema('EMAIL_MODO', MENSAGENS.SO_SMTP_EM_PRODUCAO); return; }", '')); }],
    ['M13', 'EXCLUIDA sem justificativa', 'G10', ({ catalogo }) => { catalogo.fontes[2].classe = 'EXCLUIDA'; catalogo.fontes[2].decisaoRef = 'P0-CF-2'; catalogo.fontes[2].relevancia = 'POLITICA_SEGURANCA'; catalogo.fontes[2].categoriaDeSegredo = 'CREDENCIAL'; catalogo.fontes[2].recuperacao = { procedimento: 'INDEPENDENTE', decisao: 'D-F5' }; catalogo.fontes[2].raiz = { variavel: null }; catalogo.fontes[2].justificativa = null; }],
    ['M14', 'raízes sobrepostas (mesma variável em duas fontes)', 'G10', ({ catalogo }) => { catalogo.fontes[2].raiz = { variavel: 'SINT_ARQUIVOS_DIRETORIO' }; }],
  ];
  for (const [id, descricao, regraEsperada, mutar] of casos) {
    test(`${id} — ${descricao} → ${regraEsperada}`, () => {
      const cenario = { arvore: arvoreSintetica(), catalogo: catalogoSintetico(), listas: listasSinteticas() };
      mutar(cenario);
      const r = analisar(cenario);
      assert.equal(r.aprovado, false, `${id} deveria reprovar`);
      semErroInterno(r);
      assert.ok(regrasViolidas(r).includes(regraEsperada), `${id}: esperava ${regraEsperada}; violadas: ${regrasViolidas(r).join(',')} — ${JSON.stringify(codigos(r))}`);
    });
  }
});

describe('S9 — mutações extras e falha fechada', () => {
  test('M15 — export novo no armazenamento altera a superfície → G14', () => {
    const arvore = arvoreSintetica();
    arvore.set('src/storage/sint-armazenamento.js', arvore.get('src/storage/sint-armazenamento.js').replace('module.exports = { gravar, remover, chaveDe };', 'module.exports = { gravar, remover, chaveDe, apagarTudo };'));
    const r = analisar({ arvore });
    assert.ok(regrasViolidas(r).includes('G14'), JSON.stringify(codigos(r)));
    semErroInterno(r);
  });

  test('M16 — regex de chave alterada no módulo → G14', () => {
    const arvore = arvoreSintetica();
    arvore.set('src/storage/sint-armazenamento.js', arvore.get('src/storage/sint-armazenamento.js').replace(`const CHAVE = ${REGEX_IMAGEM()};`, 'const CHAVE = /^.*$/;'));
    assert.ok(regrasViolidas(analisar({ arvore })).includes('G14'));
  });

  test('M17 — entrada de lista sem revisão humana reprova (EXCECAO_NAO_REVISADA)', () => {
    const listas = listasSinteticas();
    listas.ESCRITORES_CONHECIDOS['src/storage/sint-armazenamento.js'].revisaoHumana = 'PENDENTE';
    const r = analisar({ listas });
    assert.ok(codigos(r).includes('EXCECAO_NAO_REVISADA'));
    const semJust = listasSinteticas();
    semJust.MIGRATIONS_CONHECIDAS['migrations/001_sint.sql'].justificativa = '';
    assert.ok(codigos(analisar({ listas: semJust })).includes('EXCECAO_SEM_JUSTIFICATIVA'));
  });

  test('M18 — sinal a menos na lista também diverge; entrada conhecida sem arquivo reprova', () => {
    const listas = listasSinteticas();
    listas.ESCRITORES_CONHECIDOS['src/storage/sint-armazenamento.js'].ocorrencias = { escrita: { mkdir: 1 }, remocao: { unlink: 1 } };
    const r = analisar({ listas });
    assert.ok(codigos(r).includes('G4_SINAL_DIVERGENTE'));
    assert.ok(r.violacoes.some((v) => v.codigo === 'G4_SINAL_DIVERGENTE' && v.detalhe === 'escrita:writefile:esperado=0:real=1'), JSON.stringify(r.violacoes));
    const fantasma = listasSinteticas();
    fantasma.MIGRATIONS_CONHECIDAS['migrations/999_fantasma.sql'] = { ...fantasma.MIGRATIONS_CONHECIDAS['migrations/001_sint.sql'] };
    assert.ok(codigos(analisar({ listas: fantasma })).includes('G5_MIGRATION_CONHECIDA_INEXISTENTE'));
  });

  test('M19 — COPY ... TO e lo_export em migration reprovam (escrita pelo banco)', () => {
    const arvore = arvoreSintetica();
    arvore.set('migrations/003_sint.sql', "COPY tabela TO '/tmp/x.csv';\nSELECT lo_export(1, '/tmp/y');\n");
    const r = analisar({ arvore });
    assert.equal(codigos(r).filter((c) => c === 'G5_ESCRITA_PELO_BANCO').length, 2);
  });

  test('M20 — raiz registrada sem configuração e dependência revisada inexistente reprovam', () => {
    const arvore = arvoreSintetica();
    arvore.set('.env.example', '# vazio\n');
    arvore.set('src/config/sint.js', 'module.exports = {};\n');
    assert.ok(codigos(analisar({ arvore })).includes('G1_RAIZ_REGISTRADA_SEM_CONFIGURACAO'));
    const listas = listasSinteticas();
    listas.DEPENDENCIAS_REVISADAS.inexistente = { classificacao: 'SEM_RELACAO_COM_ARMAZENAMENTO', justificativa: 'Não está no package.', revisaoHumana: 'APROVADA', aprovadoEm: '2026-11-01' };
    assert.ok(codigos(analisar({ listas })).includes('G6_DEPENDENCIA_REVISADA_INEXISTENTE'));
  });

  test('falha fechada — árvore vazia, árvore insuficiente, catálogo inválido, listas inválidas, provedor quebrado', () => {
    assert.ok(codigos(analisar({ arvore: new Map() })).includes('ARVORE_VAZIA'));
    const listas = listasSinteticas();
    listas.minimoDeArquivos = 1000;
    assert.ok(codigos(analisar({ listas })).includes('ARVORE_INSUFICIENTE'));
    const catalogo = catalogoSintetico();
    catalogo.fontes[0].id = 'ID INVÁLIDO';
    const r = analisar({ catalogo });
    assert.ok(codigos(r).includes('CATALOGO_INVALIDO') && codigos(r).includes('G10_ID_INVALIDO'));
    assert.equal(r.aprovado, false);
    assert.ok(codigos(analisar({ listas: { minimoDeArquivos: 1 } })).includes('LISTAS_INVALIDAS'));
    const quebrado = { listar: () => ['src/a.js'], links: () => [], ler: () => { throw new Error('disco'); } };
    const rq = G().analisarArvore(quebrado, catalogoSintetico(), listasSinteticas());
    assert.equal(rq.aprovado, false);
    assert.ok(codigos(rq).includes('FALHA_DE_LEITURA') || codigos(rq).includes('ARVORE_INSUFICIENTE'));
    const errado = { listar: () => { throw new Error('x'); }, links: () => [], ler: () => '' };
    assert.ok(codigos(G().analisarArvore(errado, catalogoSintetico(), listasSinteticas())).includes('FALHA_DE_LEITURA'));
    assert.ok(codigos(G().analisarArvore(null, catalogoSintetico(), listasSinteticas())).includes('PROVEDOR_INVALIDO'));
    const semLinks = { listar: () => ['src/a.js'], ler: () => '' };
    assert.ok(codigos(G().analisarArvore(semLinks, catalogoSintetico(), listasSinteticas())).includes('PROVEDOR_INVALIDO'), 'provedor sem links() é inválido');
    const semRegistro = listasSinteticas();
    semRegistro.APROVACOES = [];
    assert.ok(codigos(analisar({ listas: semRegistro })).includes('EXCECAO_APROVACAO_SEM_REGISTRO'));
  });

  test('M21 — substituir uma API de escrita por outra, mantendo o total, reprova em G4 (identidade por sinal)', () => {
    const arvore = arvoreSintetica();
    arvore.set('src/storage/sint-armazenamento.js', arvore.get('src/storage/sint-armazenamento.js').replace('await fsp.writeFile(b, "")', 'await fsp.appendFile(b, "")'));
    const r = analisar({ arvore });
    semErroInterno(r);
    assert.equal(r.aprovado, false, 'troca de writeFile por appendFile com a mesma contagem deveria reprovar');
    assert.ok(codigos(r).includes('G4_SINAL_DIVERGENTE'), JSON.stringify(codigos(r)));
    const arvore2 = arvoreSintetica();
    arvore2.set('src/storage/sint-armazenamento.js', arvore2.get('src/storage/sint-armazenamento.js').replace('await fsp.unlink(a)', 'await fsp.rm(a)'));
    assert.ok(codigos(analisar({ arvore: arvore2 })).includes('G4_SINAL_DIVERGENTE'), 'unlink → rm com a mesma contagem');
    const arvore3 = arvoreSintetica();
    arvore3.set('src/storage/sint-armazenamento.js', arvore3.get('src/storage/sint-armazenamento.js').replace('await fsp.mkdir(a); await fsp.writeFile(b, "")', 'await fsp.rename(a, b); await fsp.writeFile(b, "")'));
    assert.ok(codigos(analisar({ arvore: arvore3 })).includes('G4_SINAL_DIVERGENTE'), 'mkdir → rename com a mesma contagem');
  });

  test('M22 — trocar o token de persistência numa migration, mantendo a contagem, reprova em G5', () => {
    const arvore = arvoreSintetica();
    arvore.set('migrations/001_sint.sql', arvore.get('migrations/001_sint.sql').replace('sha256 CHAR(64) NOT NULL', 'chave_armazenamento VARCHAR(80) NOT NULL'));
    const r = analisar({ arvore });
    semErroInterno(r);
    assert.equal(r.aprovado, false);
    assert.ok(codigos(r).includes('G5_SINAL_DIVERGENTE'), JSON.stringify(codigos(r)));
  });

  test('M23 — trocar o sinal de uma rota binária, mantendo a contagem, reprova em G7', () => {
    const arvore = arvoreSintetica();
    arvore.set('src/routes/sint.routes.js', "router.post('/x', conteudo('application/octet-stream'), ctrl);\n");
    const r = analisar({ arvore });
    semErroInterno(r);
    assert.equal(r.aprovado, false);
    assert.ok(codigos(r).includes('G7_SINAL_DIVERGENTE'), JSON.stringify(codigos(r)));
  });

  test('M24 — a mesma constante de exceção G1 em outro arquivo, ou um uso a mais no mesmo arquivo, reprova', () => {
    const arvore = arvoreSintetica();
    arvore.set('src/config/outro.js', "const X = 'SINT_CONSTANTE_DIRETORIO';\nmodule.exports = { X };\n");
    const r = analisar({ arvore });
    semErroInterno(r);
    assert.ok(codigos(r).includes('G1_RAIZ_SEM_REGISTRO'), `outro arquivo: ${JSON.stringify(codigos(r))}`);
    const arvore2 = arvoreSintetica();
    arvore2.set('.env.example', `${arvore2.get('.env.example')}SINT_CONSTANTE_DIRETORIO=\n`);
    const r2 = analisar({ arvore: arvore2 });
    assert.ok(codigos(r2).includes('G1_EXCECAO_CONTAGEM_DIVERGENTE'), `uso a mais: ${JSON.stringify(codigos(r2))}`);
  });

  test('M25 — link simbólico sintético dentro da árvore analisada reprova por LINK_SIMBOLICO_NA_ARVORE (sem seguir o link)', () => {
    const arvore = arvoreSintetica();
    arvore.set('src/services/atalho.js', G().LINK_SIMBOLICO);
    const r = analisar({ arvore });
    assert.equal(r.aprovado, false);
    assert.ok(codigos(r).includes('LINK_SIMBOLICO_NA_ARVORE'), JSON.stringify(codigos(r)));
    assert.ok(!codigos(r).includes('FALHA_DE_LEITURA') && !codigos(r).includes('ERRO_INTERNO_DO_DETECTOR'), 'o link não pode virar erro incidental');
    const v = r.violacoes.find((x) => x.codigo === 'LINK_SIMBOLICO_NA_ARVORE');
    assert.equal(v.arquivo, 'src/services/atalho.js');
  });

  test('M27 — link simbólico com nome deliberadamente excluído (node_modules, coverage, .git) NÃO é violação; link inesperado continua sendo', () => {
    const arvore = arvoreSintetica();
    for (const nome of G().DIRETORIOS_IGNORADOS) arvore.set(nome, G().LINK_SIMBOLICO);
    arvore.set('src/node_modules', G().LINK_SIMBOLICO);
    arvore.set('node_modules/pacote/index.js', 'module.exports = {};\n');
    const r = analisar({ arvore });
    assert.equal(r.aprovado, true, JSON.stringify(r.violacoes));
    assert.equal(r.links, 0);
    assert.ok(!r.ocorrencias.some((o) => o.arquivo.includes('node_modules')), 'nada sob node_modules é varrido');
    // Controle do caso oposto na MESMA árvore: um link fora das exclusões continua reprovando, sem ser seguido.
    arvore.set('scripts/atalho.js', G().LINK_SIMBOLICO);
    const r2 = analisar({ arvore });
    assert.equal(r2.aprovado, false);
    assert.deepEqual(r2.violacoes.filter((v) => v.codigo === 'LINK_SIMBOLICO_NA_ARVORE').map((v) => v.arquivo), ['scripts/atalho.js']);
    // Regra única por segmento, exportada para os dois provedores.
    assert.equal(G().ehIgnorado('src/x/coverage/y.js'), true);
    assert.equal(G().ehIgnorado('src/coverage.js'), false);
    assert.equal(G().ehIgnorado('.git'), true);
  });

  test('M26 — aprovação sem registro rastreável, registro adulterado e pendência de comprovação aprovada reprovam', () => {
    const listas = listasSinteticas();
    listas.ESCRITORES_CONHECIDOS['src/storage/sint-armazenamento.js'].aprovacaoRef = 'GATE-P2-2026-11-01-ZZZ';
    const r = analisar({ listas });
    assert.ok(codigos(r).includes('EXCECAO_APROVACAO_SEM_REGISTRO'), JSON.stringify(codigos(r)));
    const arvore = arvoreSintetica();
    arvore.set('docs/aprovacao-sint.md', 'texto adulterado\n');
    const r2 = analisar({ arvore });
    assert.ok(codigos(r2).includes('REGISTRO_DE_APROVACAO_INVALIDO'), JSON.stringify(codigos(r2)));
    const pend = listasSinteticas();
    pend.DEPENDENCIAS_REVISADAS.sharp = { ...pend.DEPENDENCIAS_REVISADAS.sharp, classificacao: 'PENDENTE_DE_COMPROVACAO', hipotese: 'Processamento em memória.', comprovacaoPendente: 'Escrita temporária do processo filho não verificada.' };
    const r3 = analisar({ listas: pend });
    assert.equal(r3.aprovado, false, 'pendência de comprovação nunca deixa a linha de base verde');
    assert.ok(codigos(r3).includes('EXCECAO_PENDENTE_DE_COMPROVACAO') && codigos(r3).includes('EXCECAO_PENDENTE_APROVADA'), JSON.stringify(codigos(r3)));
    const semRef = listasSinteticas();
    delete semRef.ESCRITORES_CONHECIDOS['src/storage/sint-armazenamento.js'].aprovacaoRef;
    assert.ok(codigos(analisar({ listas: semRef })).includes('EXCECAO_NAO_REVISADA'));
    const antigo = listasSinteticas();
    antigo.ESCRITORES_CONHECIDOS['src/storage/sint-armazenamento.js'].ocorrencias = { escrita: 2, remocao: 1 };
    assert.ok(codigos(analisar({ listas: antigo })).includes('EXCECAO_CONTAGEM_FORMATO_INVALIDO'), 'estrutura antiga de contagem não é aceita');
  });

  test('o provedor em memória não toca o disco e as mutações não alteram o cenário base', () => {
    const base = arvoreSintetica();
    const copia = new Map(base);
    const r1 = analisar({ arvore: base });
    assert.deepEqual([...base.entries()], [...copia.entries()]);
    assert.equal(r1.aprovado, true);
    assert.equal(analisar().aprovado, true, 'o cenário base continua verde depois de todas as mutações');
  });
});
