'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');

const RAIZ = path.join(__dirname, '..', '..');
const ler = (relativo) => fs.readFileSync(path.join(RAIZ, relativo), 'utf8');
const existe = (relativo) => fs.existsSync(path.join(RAIZ, relativo));
const C = () => exigirModulo('src/services/backup-fontes-catalogo.service');
const R = () => exigirModulo('src/services/backup-fontes-regras.service');
const fonte = (id) => {
  const f = C().obterCatalogo().fontes.find((x) => x.id === id);
  assert.ok(f, `fonte ${id} ausente do catálogo`);
  return f;
};
const HEX = 'a'.repeat(64);

describe('S6 — catálogo inicial (P1): fontes reais, estados aprovados no P0', () => {
  test('o catálogo inicial valida, é selado e registrado', () => {
    const catalogo = C().obterCatalogo();
    assert.equal(R().validarCatalogo(catalogo).valido, true, JSON.stringify(R().validarCatalogo(catalogo).erros));
    assert.ok(Object.isFrozen(catalogo) && R().ehFonteRegistrada(catalogo));
    for (const f of catalogo.fontes) assert.ok(R().ehFonteRegistrada(f), f.id);
    assert.equal(C().obterCatalogo(), catalogo, 'mesma instância a cada chamada');
    assert.deepEqual(catalogo.fontes.map((f) => f.id), [...catalogo.fontes.map((f) => f.id)].sort(), 'ordenado por id');
  });

  test('C04 — estados iniciais aprovados (CF-3, PostgreSQL, D-F1, D-F2, CF-1, CF-2)', () => {
    const estado = (id) => R().estadoDeCobertura(fonte(id));
    assert.equal(fonte('imagens').classe, 'PROTEGIDA');
    assert.equal(estado('imagens'), 'IMPLEMENTADA_NAO_COMPROVADA');
    assert.equal(fonte('imagens').promocao, null);
    assert.equal(fonte('postgres-aplicacao').classe, 'PROTEGIDA');
    assert.equal(estado('postgres-aplicacao'), 'IMPLEMENTACAO_PARCIAL');
    assert.equal(fonte('fiscalizacao-pacotes').classe, null);
    assert.equal(fonte('fiscalizacao-pacotes').decisaoPendente, 'D-F1');
    assert.equal(fonte('fiscalizacao-pacotes').recomendacao, 'PROTEGIDA');
    assert.equal(estado('fiscalizacao-pacotes'), 'PENDENTE_DECISAO');
    assert.equal(fonte('email-arquivo').classe, null);
    assert.equal(fonte('email-arquivo').decisaoPendente, 'D-F2');
    assert.equal(fonte('email-arquivo').recomendacao, 'EFEMERA');
    assert.equal(estado('email-arquivo'), 'PENDENTE_DECISAO');
    assert.equal(fonte('janela-escrita').classe, 'EFEMERA');
    assert.equal(estado('janela-escrita'), 'DECLARADA_EFEMERA');
    for (const f of C().obterCatalogo().fontes) {
      assert.notEqual(R().estadoDeCobertura(f), 'PROTEGIDA_COMPROVADA', `${f.id} não pode iniciar comprovada`);
      assert.equal(R().incluidaNoPacote(f), false, `${f.id} não entra no pacote`);
    }
  });

  test('X01 — catálogo inicial: teto NAO_COMPROVADA, com e sem contexto favorável', () => {
    const catalogo = C().obterCatalogo();
    assert.equal(R().tetoDeDeclaracao(catalogo), 'NAO_COMPROVADA');
    const favoravel = {
      raizesConfiguradas: catalogo.fontes.map((f) => f.raiz.variavel).filter(Boolean),
      nivelPostgres: 'N3',
      resultadosDinamicos: Object.fromEntries(catalogo.fontes.map((f) => [f.id, 'APROVADO'])),
    };
    const avaliacao = R().avaliarCobertura(catalogo, favoravel);
    assert.equal(avaliacao.teto, 'NAO_COMPROVADA');
    assert.ok(avaliacao.motivos.includes('NENHUMA_FONTE_COMPROVADA'));
  });

  test('pendências do catálogo inicial: códigos fechados', () => {
    assert.deepEqual(R().pendenciasDeCobertura(C().obterCatalogo()).map((p) => [p.fonteId, p.codigo]), [
      ['email-arquivo', 'CLASSE_NAO_DECIDIDA'],
      ['fiscalizacao-pacotes', 'CLASSE_NAO_DECIDIDA'],
      ['imagens', 'NAO_COMPROVADA'],
      ['postgres-aplicacao', 'COMPONENTE_PARCIAL:verificador'],
    ]);
  });

  test('X03 — identificadores P0-CF-1, P0-CF-2 e P0-CF-3 rastreáveis', () => {
    assert.equal(fonte('janela-escrita').decisaoRef, 'P0-CF-1');
    const segredos = C().obterCatalogo().fontes.filter((f) => f.classe === 'EXCLUIDA' && f.relevancia === 'POLITICA_SEGURANCA');
    assert.equal(segredos.length, 4, 'uma fonte por categoria fechada de segredo');
    assert.deepEqual(segredos.map((f) => f.categoriaDeSegredo).sort(), ['ARQUIVO_DE_AMBIENTE', 'CHAVE_PRIVADA', 'CREDENCIAL', 'SEGREDO_DE_APLICACAO']);
    for (const f of segredos) {
      assert.equal(f.decisaoRef, 'P0-CF-2', f.id);
      assert.deepEqual(f.recuperacao, { procedimento: 'INDEPENDENTE', decisao: 'D-F5' }, f.id);
      assert.deepEqual(f.referencias, [], f.id);
      assert.equal(f.escopo.tipo, 'GLOBAL', f.id);
      assert.equal(f.raiz.variavel, null, f.id);
    }
    assert.equal(C().DECISOES_DO_P0['P0-CF-3'].fonteId, 'imagens');
    assert.equal(C().DECISOES_DO_P0['P0-CF-3'].estadoInicial, 'IMPLEMENTADA_NAO_COMPROVADA');
    assert.equal(C().DECISOES_DO_P0['P0-CF-1'].fonteId, 'janela-escrita');
    assert.deepEqual(C().DECISOES_DO_P0['P0-CF-2'].fonteIds, segredos.map((f) => f.id).sort());
    for (const d of Object.values(C().DECISOES_DO_P0)) assert.match(d.documento, /ADENDO-DECISOES-20261101/);
  });

  test('X04/X05 — persistência física e política de recuperação das fontes efêmeras, excluídas e pendentes', () => {
    const janela = fonte('janela-escrita');
    assert.equal(janela.persistenciaFisica, 'SIM');
    assert.equal(janela.relevancia, 'NAO_PERSISTENTE');
    assert.equal(janela.riscoResidual, 'TRAVA_OBSOLETA_BLOQUEIA_OPERACAO');
    assert.match(R().descreverPoliticaDeRecuperacao(janela), /fisicamente persistente/);
    const email = fonte('email-arquivo');
    assert.equal(email.persistenciaFisica, 'SIM');
    assert.equal(email.relevancia, 'PERSISTENTE_DE_BAIXO_VALOR');
    assert.equal(email.riscoResidual, 'DADO_PESSOAL_E_TOKENS');
    const fisc = fonte('fiscalizacao-pacotes');
    assert.equal(fisc.persistenciaFisica, 'SIM');
    assert.equal(fisc.relevancia, 'PERSISTENTE_RELEVANTE');
    for (const f of C().obterCatalogo().fontes.filter((x) => x.classe === 'EXCLUIDA')) {
      assert.equal(f.relevancia, 'POLITICA_SEGURANCA');
      assert.match(R().descreverPoliticaDeRecuperacao(f), /recuperação independente/);
    }
    assert.ok(C().obterCatalogo().fontes.every((f) => f.relevancia !== 'PERSISTENTE_RELEVANTE' || f.classe !== 'EXCLUIDA'), 'nenhum dado relevante excluído');
  });

  test('X08 — o catálogo não contém valores, caminhos reais, credenciais ou dados pessoais', () => {
    const texto = JSON.stringify(C().obterCatalogo());
    assert.doesNotMatch(texto, /\/Users\/|\/home\/|\/var\/|\/tmp\/|C:\\\\/);
    assert.doesNotMatch(texto, /postgres:\/\/|password=|senha=|[0-9]{3}\.[0-9]{3}\.[0-9]{3}-[0-9]{2}|@[a-z0-9-]+\.[a-z]{2,}/i);
    assert.doesNotMatch(texto, /\b[0-9a-f]{64}\b/, 'nenhum hash de conteúdo no catálogo');
    assert.doesNotMatch(texto, /BEGIN (RSA |EC |OPENSSH )?PRIVATE KEY/);
    assert.doesNotMatch(texto, /\bcertificad/i, 'a palavra "certificado" não classifica nada');
  });

  test('a projeção do catálogo inicial é determinística e sem campos de decisão', () => {
    const p1 = R().projetarParaManifesto(C().obterCatalogo());
    const p2 = R().projetarParaManifesto(structuredClone(C().obterCatalogo()));
    assert.deepEqual(p1, p2);
    assert.equal(p1.sha256, C().hashDoCatalogoInicial());
    assert.match(p1.sha256, /^[0-9a-f]{64}$/);
    assert.ok(p1.fontes.every((f) => f.incluida === false));
  });
});

describe('S6 — contratos com os módulos históricos (somente leitura)', () => {
  test('C01 — o planejador existente aceita exatamente { padrao, empresa } e o catálogo referencia essas tabelas', () => {
    const { planejarArquivos } = exigirModulo('src/services/imagem-backup-plano.service');
    assert.deepEqual(planejarArquivos({ padrao: [], empresa: [] }), []);
    assert.throws(() => planejarArquivos({ padrao: [], empresa: [], fiscalizacao: [] }));
    assert.throws(() => planejarArquivos({ padrao: [] }));
    assert.throws(() => planejarArquivos({ padrao: [], empresas: [] }));
    assert.deepEqual(fonte('imagens').referencias.map((r) => r.tabela).sort(), ['imagens_empresa', 'imagens_padrao']);
    assert.ok(fonte('imagens').referencias.every((r) => r.colunas.includes('sha256')));
    assert.ok(fonte('imagens').referencias.find((r) => r.tabela === 'imagens_empresa').colunas.includes('empresa_id'));
  });

  test('C02 — conformidade por corpus do formato de chave "imagem-v1" com chaveDe e com as regex históricas', () => {
    const { chaveDe } = exigirModulo('src/storage/armazenamento-imagens');
    const regex = R().FORMATOS_DE_CHAVE['imagem-v1'];
    assert.equal(fonte('imagens').chave.formatoChaveId, 'imagem-v1');

    const validas = [
      [`1/${HEX}/mestre.png`, { escopo: 'EMPRESA', empresaId: 1, sha256: HEX, variante: 'mestre', formato: 'PNG' }],
      [`42/${HEX}/mestre.jpg`, { escopo: 'EMPRESA', empresaId: 42, sha256: HEX, variante: 'mestre', formato: 'JPEG' }],
      [`999999999999999/${HEX}/mestre.webp`, { escopo: 'EMPRESA', empresaId: 999999999999999, sha256: HEX, variante: 'mestre', formato: 'WEBP' }],
      [`padrao/${HEX}/exibicao.webp`, { escopo: 'PADRAO', sha256: HEX, variante: 'exibicao', formato: 'WEBP' }],
      [`7/${HEX}/miniatura.webp`, { escopo: 'EMPRESA', empresaId: 7, sha256: HEX, variante: 'miniatura', formato: 'WEBP' }],
    ];
    for (const [chave, entrada] of validas) {
      assert.equal(regex.test(chave), true, chave);
      assert.equal(chaveDe(entrada), chave);
    }
    const invalidas = [
      [`0/${HEX}/mestre.png`, { escopo: 'EMPRESA', empresaId: 0, sha256: HEX, variante: 'mestre', formato: 'PNG' }],
      [`01/${HEX}/mestre.png`, null],
      [`1000000000000000/${HEX}/mestre.png`, { escopo: 'EMPRESA', empresaId: 1000000000000000, sha256: HEX, variante: 'mestre', formato: 'PNG' }],
      [`1/${HEX.toUpperCase()}/mestre.png`, { escopo: 'EMPRESA', empresaId: 1, sha256: HEX.toUpperCase(), variante: 'mestre', formato: 'PNG' }],
      [`1/${HEX.slice(1)}/mestre.png`, { escopo: 'EMPRESA', empresaId: 1, sha256: HEX.slice(1), variante: 'mestre', formato: 'PNG' }],
      [`1/${HEX}/mestre.gif`, { escopo: 'EMPRESA', empresaId: 1, sha256: HEX, variante: 'mestre', formato: 'GIF' }],
      [`1/${HEX}/exibicao.png`, { escopo: 'EMPRESA', empresaId: 1, sha256: HEX, variante: 'exibicao', formato: 'PNG' }],
      [`1/${HEX}/original.png`, { escopo: 'EMPRESA', empresaId: 1, sha256: HEX, variante: 'original', formato: 'PNG' }],
      [`padrao/${HEX}/mestre.png/`, null],
      [`../${HEX}/mestre.png`, null],
      [`Padrao/${HEX}/mestre.png`, null],
      [`1/${HEX}`, null],
      ['', null],
    ];
    for (const [chave, entrada] of invalidas) {
      assert.equal(regex.test(chave), false, chave);
      if (entrada) assert.throws(() => chaveDe(entrada), (e) => e.codigo === 'CHAVE_INVALIDA', chave);
    }
    // Chave textual válida, mas entrada incoerente para o montador: a regex aceita o texto; `chaveDe` recusa a entrada.
    assert.equal(regex.test(`padrao/${HEX}/mestre.png`), true);
    assert.throws(() => chaveDe({ escopo: 'PADRAO', empresaId: 1, sha256: HEX, variante: 'mestre', formato: 'PNG' }), (e) => e.codigo === 'CHAVE_INVALIDA');

    const literal = (relativo) => {
      const m = ler(relativo).match(/^const CHAVE = (\/.*\/);$/m);
      assert.ok(m, `regex CHAVE não encontrada em ${relativo}`);
      return m[1];
    };
    const esperado = `/${regex.source}/`;
    for (const relativo of ['src/storage/armazenamento-imagens.js', 'src/services/imagem-backup-manifesto.service.js', 'src/services/imagem-backup-verificacao-imagens-copiadas.service.js']) {
      assert.equal(literal(relativo), esperado, relativo);
    }
  });

  test('C03 — o pg_dump continua sem filtro (args fechados) e a fonte POSTGRES é coerente com isso', () => {
    const texto = ler('src/services/imagem-backup-pgdump-lancador.service.js');
    for (const proibido of ['--schema', '--table', '--exclude', '--no-blobs', '--data-only', '--schema-only', '--section', '--no-acl', '--no-owner']) {
      assert.ok(!texto.includes(proibido), `argumento ${proibido} presente no lançador`);
    }
    assert.match(texto, /--format=custom/);
    assert.match(texto, /--snapshot=/);
    const banco = fonte('postgres-aplicacao');
    assert.equal(banco.tipo, 'POSTGRES');
    assert.equal(banco.raiz.variavel, null);
    assert.equal(banco.chave.formatoChaveId, null);
    assert.equal(banco.verificadorId, 'postgres-estrutura-v1');
    assert.equal(banco.componentes.verificador.estado, 'PARCIAL');
  });

  test('C05 — módulos e testes declarados como componentes existem como arquivos', () => {
    for (const f of C().obterCatalogo().fontes) {
      for (const [nome, c] of Object.entries(f.componentes)) {
        if (c.modulo !== null) assert.ok(existe(c.modulo), `${f.id}.${nome}: ${c.modulo}`);
        if (c.teste !== null) assert.ok(existe(c.teste), `${f.id}.${nome}: ${c.teste}`);
        if (c.estado === 'PRESENTE') assert.ok(c.modulo && c.teste, `${f.id}.${nome} PRESENTE sem módulo ou teste`);
      }
    }
    const img = fonte('imagens').componentes;
    assert.equal(img.planejador.modulo, 'src/services/imagem-backup-plano.service.js');
    assert.equal(img.restaurador.modulo, 'src/services/imagem-backup-restauracao.service.js');
  });

  test('C06 — a recusa do modo arquivo em produção continua no código e nos testes existentes', () => {
    const config = ler('src/config/email.js');
    assert.match(config, /producao && e\.EMAIL_MODO !== 'smtp'/);
    assert.match(config, /SO_SMTP_EM_PRODUCAO/);
    assert.match(ler('test/config/email.test.js'), /NODE_ENV: 'production', EMAIL_MODO: 'arquivo'/);
    assert.match(ler('test/app-producao-email.test.js'), /EMAIL_MODO: 'arquivo'/);
    assert.equal(fonte('email-arquivo').raiz.variavel, 'EMAIL_ARQUIVO_DIRETORIO');
  });

  test('C07 — raízes do .env.example e de src/config ⇄ catálogo, nos dois sentidos', () => {
    const padrao = /\b[A-Z][A-Z0-9_]*(?:_DIRETORIO|_ARQUIVO|_ARMAZENAMENTO[A-Z0-9_]*|_BUCKET|_STORAGE|_UPLOAD[A-Z0-9_]*)\b/g;
    const encontradas = new Set();
    const porArquivo = new Map();
    const fontesTexto = ['.env.example', ...fs.readdirSync(path.join(RAIZ, 'src', 'config')).filter((n) => n.endsWith('.js')).map((n) => `src/config/${n}`)];
    for (const relativo of fontesTexto) {
      for (const m of ler(relativo).matchAll(padrao)) {
        encontradas.add(m[0]);
        const chave = `${relativo}\n${m[0]}`;
        porArquivo.set(chave, (porArquivo.get(chave) ?? 0) + 1);
      }
    }
    const noCatalogo = new Set(C().obterCatalogo().fontes.map((f) => f.raiz.variavel).filter(Boolean));
    const excecoes = new Map(C().NOMES_QUE_NAO_SAO_RAIZ.map((e) => [`${e.arquivo}\n${e.nome}`, e.ocorrencias]));
    for (const [chave, n] of porArquivo) {
      const [, nome] = chave.split('\n');
      if (noCatalogo.has(nome)) continue;
      assert.ok(excecoes.has(chave), `raiz não registrada: ${chave.replace('\n', ' ')}`);
      assert.equal(excecoes.get(chave), n, `contagem da exceção ${chave.replace('\n', ' ')}`);
    }
    for (const nome of noCatalogo) assert.ok(encontradas.has(nome), `raiz registrada sem configuração: ${nome}`);
    for (const [chave] of excecoes) { assert.ok(porArquivo.has(chave), `exceção sem ocorrência: ${chave}`); assert.ok(!noCatalogo.has(chave.split('\n')[1])); }
    assert.deepEqual([...noCatalogo].sort(), ['EMAIL_ARQUIVO_DIRETORIO', 'FISCALIZACAO_ARMAZENAMENTO_DIRETORIO', 'IMAGENS_ARMAZENAMENTO_DIRETORIO', 'IMAGENS_JANELA_ESCRITA_ARQUIVO']);
  });

  test('o módulo do catálogo só depende das regras e não lê ambiente, disco, banco ou rede', () => {
    const texto = ler('src/services/backup-fontes-catalogo.service.js');
    const requeridos = [...texto.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    assert.deepEqual(requeridos, ['./backup-fontes-regras.service']);
    assert.doesNotMatch(texto, /process\.env/);
  });
});
