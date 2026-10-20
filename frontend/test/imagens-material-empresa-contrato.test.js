'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const E = require('./helpers/imagens-material-empresa');
const schemas = require('../../backend/src/schemas/imagem-material.schema');
const schemasDeEntrega = require('../../backend/src/schemas/imagem-material-entrega.schema');
const schemasDeMaterial = require('../../backend/src/schemas/material.schema');
const { METODOS_PORTAL } = require('../../backend/src/middleware/cors');

/**
 * Unidade 5C-7 — o CONTRATO REAL do backend que o frontend do upload e do gerenciamento das imagens da empresa vai usar, CONFERIDO por teste a partir do código-fonte e dos
 * schemas do backend (rotas, permissões, limites, validações, códigos de erro, CORS). Todos nascem VERDES: se o backend mudar uma rota, uma permissão ou um limite, o teste que
 * o descreve falha com o nome do que a tela perde, antes de o frontend quebrar em silêncio. Não inventa rota, campo nem permissão: tudo abaixo foi lido em
 * backend/src/routes/imagem-material.routes.js, schemas/imagem-material*.schema.js, schemas/material.schema.js, config/imagens.js, middleware/cors.js e nos serviços.
 */

const BACKEND = path.join(E.RAIZ, '..', 'backend');
const semComentarios = (texto) => texto.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const ler = (relativo) => semComentarios(fs.readFileSync(path.join(BACKEND, relativo), 'utf8'));

/** As chamadas `router.<verbo>(...)` do arquivo de rotas: verbo, caminho e o texto da cadeia de middlewares. */
function rotasDoBackend() {
  const fonte = ler('src/routes/imagem-material.routes.js');
  return [...fonte.matchAll(/router\.(get|post|patch|put|delete)\(([\s\S]*?)\n\s*\);/g)].map((m) => ({
    metodo: m[1].toUpperCase(), caminho: /'([^']+)'/.exec(m[2])[1], cadeia: m[2],
  }));
}
const rota = (metodo, caminho) => rotasDoBackend().find((r) => r.metodo === metodo && r.caminho === caminho);

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 CT — rotas e permissões (o que a tela pode chamar)', () => {
  test('CT-01 são exatamente sete rotas de imagem: listar, entregar, enviar, renomear, inativar, reativar e excluir — nenhuma outra existe', () => {
    assert.deepEqual(rotasDoBackend().map((r) => `${r.metodo} ${r.caminho}`).sort(), [
      'DELETE /imagens-material/empresa/:id',
      'GET /imagens-material',
      'GET /imagens-material/:origem/:id/:variante',
      'PATCH /imagens-material/empresa/:id',
      'POST /imagens-material/empresa',
      'POST /imagens-material/empresa/:id/inativar',
      'POST /imagens-material/empresa/:id/reativar',
    ]);
  });

  test('CT-02 permissão por rota: ver e entregar = materials.visualizar; enviar = materials.criar; renomear, inativar, reativar e excluir = materials.editar (e só uma delas em cada rota)', () => {
    const esperado = [
      ['GET', '/imagens-material', 'exigirVisualizar'], ['GET', '/imagens-material/:origem/:id/:variante', 'exigirVisualizar'], ['POST', '/imagens-material/empresa', 'exigirCriar'],
      ['PATCH', '/imagens-material/empresa/:id', 'exigirEditar'], ['POST', '/imagens-material/empresa/:id/inativar', 'exigirEditar'], ['POST', '/imagens-material/empresa/:id/reativar', 'exigirEditar'],
      ['DELETE', '/imagens-material/empresa/:id', 'exigirEditar'],
    ];
    for (const [metodo, caminho, permissao] of esperado) {
      const r = rota(metodo, caminho);
      assert.ok(r, `${metodo} ${caminho}`);
      const usadas = ['exigirVisualizar', 'exigirCriar', 'exigirEditar'].filter((n) => r.cadeia.includes(n));
      assert.deepEqual(usadas, [permissao], `${metodo} ${caminho}`);
      assert.ok(r.cadeia.includes('exigirSessaoInjetado'), `${metodo} ${caminho} exige sessão`);
    }
    assert.match(ler('src/routes/imagem-material.routes.js'), /const RECURSO = 'materials'/);
  });

  test('CT-03 no envio, a ordem é sessão → materials.criar → limites por usuário e por empresa → corpo binário → validação da consulta → controller: o corpo só é lido depois da autorização', () => {
    const { cadeia } = rota('POST', '/imagens-material/empresa');
    const posicoes = ['exigirSessaoInjetado', 'exigirCriar', 'limitarEnvioPorUsuario', 'limitarEnvioPorEmpresa', 'lerImagemBinaria', 'validar({ query: schemas.enviar.query })', 'controller.enviar'].map((n) => cadeia.indexOf(n));
    assert.equal(posicoes.every((p) => p >= 0), true, JSON.stringify(posicoes));
    assert.deepEqual([...posicoes].sort((a, b) => a - b), posicoes, 'fora de ordem');
  });

  test('CT-04 o único verbo com corpo binário é o do envio: as outras rotas de escrita recebem JSON validado (renomear { nome }, inativar e reativar {}, excluir { confirmacao })', () => {
    for (const [metodo, caminho, parte] of [['PATCH', '/imagens-material/empresa/:id', 'schemas.renomear.body'], ['POST', '/imagens-material/empresa/:id/inativar', 'schemas.inativar.body'],
      ['POST', '/imagens-material/empresa/:id/reativar', 'schemas.reativar.body'], ['DELETE', '/imagens-material/empresa/:id', 'schemas.excluir.body']]) {
      assert.ok(rota(metodo, caminho).cadeia.includes(parte), `${metodo} ${caminho} valida ${parte}`);
      assert.equal(rota(metodo, caminho).cadeia.includes('lerImagemBinaria'), false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 CT — limites do backend (os que o frontend repete só para orientar a pessoa)', () => {
  test('CT-05 arquivo ≤ 2 MiB, lado de 320 a 4096 px, ≤ 8.388.608 pixels, lote de 10, nome de 1 a 100, formatos PNG, JPEG e WebP, listagem em páginas de até 100', () => {
    const c = E.LIMITES_DO_BACKEND;
    assert.deepEqual([c.arquivoMaxBytes, c.ladoMin, c.ladoMax, c.pixelsMax, c.loteMaximo], [2 * E.MIB, 320, 4096, 8388608, 10]);
    assert.deepEqual([c.nome.min, c.nome.max], [1, 100]);
    assert.deepEqual([...c.formatosAceitos], ['PNG', 'JPEG', 'WEBP']);
    assert.equal(schemas.listar.query.safeParse({ limite: '100' }).success, true);
    assert.equal(schemas.listar.query.safeParse({ limite: '101' }).success, false);
    assert.equal(require('../js/imagens-material').LIMITE_LISTA, 100, 'o módulo da seleção pede páginas do tamanho máximo');
  });

  test('CT-06 um lote cheio (10 arquivos) consome TODA a cota de envios por minuto do usuário (10), a empresa tem 60 por hora e o servidor processa 2 por vez com fila de 8: por isso o envio é um a um, sem repetição automática', () => {
    const c = E.LIMITES_DO_BACKEND;
    assert.deepEqual([c.envioPorMinutoUsuario, c.envioPorHoraEmpresa, c.processamentosSimultaneos, c.processamento.fila.maxima], [10, 60, 2, 8]);
    assert.equal(c.envioPorMinutoUsuario, c.loteMaximo);
    assert.deepEqual([c.processamento.fila.retryAfterFilaCheiaSegundos, c.processamento.fila.retryAfterEsperaSegundos], [5, 10]);
    assert.deepEqual([c.cotaImagens, c.cotaBytes], [300, 300 * E.MIB]);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 CT — schemas: o que o servidor aceita e recusa', () => {
  test('CT-07 listar: padrões TODAS / ATIVA / página 1 / limite 20; aceita os filtros do contrato; recusa origem em minúsculas, estado inventado, limite acima de 100, página 0 e chave desconhecida', () => {
    const q = schemas.listar.query;
    assert.deepEqual(q.parse({}), { pagina: 1, limite: 20, origem: 'TODAS', estado: 'ATIVA' });
    assert.equal(q.safeParse({ origem: 'EMPRESA', estado: 'TODAS', pagina: '2', limite: '100', busca: 'luva', tipoNome: 'Luva' }).success, true);
    for (const ruim of [{ origem: 'empresa' }, { origem: 'OUTRA' }, { estado: 'ZZZ' }, { limite: '101' }, { limite: '0' }, { pagina: '0' }, { pagina: '10001' }, { pagina: '1.5' }, { busca: '' }, { busca: 'x'.repeat(101) }, { empresaId: '3' }, { x: '1' }]) {
      assert.equal(q.safeParse(ruim).success, false, JSON.stringify(ruim));
    }
  });

  test('CT-08 enviar: a consulta leva SÓ nome (1 a 100 pontos de código, sem controle); ausente, repetido ou com chave extra é recusado', () => {
    const q = schemas.enviar.query;
    assert.deepEqual(q.parse({ nome: '  Luva  ' }), { nome: 'Luva' });
    assert.equal(q.safeParse({ nome: '😀'.repeat(100) }).success, true);
    for (const ruim of [{}, { nome: '' }, { nome: 'x'.repeat(101) }, { nome: 'a\u0007b' }, { nome: ['A', 'B'] }, { nome: 'A', empresaId: '1' }, { nome: 'A', criadoPor: '1' }, { nome: 'A', caminho: 'x' }]) {
      assert.equal(q.safeParse(ruim).success, false, JSON.stringify(ruim));
    }
  });

  test('CT-09 renomear { nome }, inativar e reativar {}, excluir { confirmacao: true }: estritos; id da imagem é BIGINT em texto canônico, sem perder precisão', () => {
    assert.equal(schemas.renomear.body.safeParse({ nome: 'Novo' }).success, true);
    for (const ruim of [{}, { nome: '' }, { nome: 'A', estado: 'INATIVA' }, { id: '1' }, undefined]) assert.equal(schemas.renomear.body.safeParse(ruim).success, false, JSON.stringify(ruim));
    for (const esquema of [schemas.inativar, schemas.reativar]) {
      assert.equal(esquema.body.safeParse({}).success, true);
      for (const ruim of [{ x: 1 }, undefined, null]) assert.equal(esquema.body.safeParse(ruim).success, false, JSON.stringify(ruim));
    }
    assert.equal(schemas.excluir.body.safeParse({ confirmacao: true }).success, true);
    for (const ruim of [{}, { confirmacao: false }, { confirmacao: 'true' }, { confirmacao: 1 }, { confirmacao: true, x: 1 }]) assert.equal(schemas.excluir.body.safeParse(ruim).success, false, JSON.stringify(ruim));
    assert.equal(schemas.renomear.params.parse({ id: E.ID_GRANDE_EMPRESA }).id, E.ID_GRANDE_EMPRESA);
    for (const ruim of ['0', '07', '-1', '1.5', 'abc', '9223372036854775808', ' 1']) assert.equal(schemas.renomear.params.safeParse({ id: ruim }).success, false, ruim);
  });

  test('CT-10 entregar: origem e variante entram como texto (valor desconhecido é 404 do serviço, nunca 400); só a chave v (inteiro positivo) é aceita na consulta', () => {
    const { entregar } = schemasDeEntrega;
    assert.equal(entregar.params.safeParse({ origem: 'empresa', id: '7001', variante: 'miniatura' }).success, true);
    assert.equal(entregar.params.safeParse({ origem: 'qualquer', id: '7001', variante: 'qualquer' }).success, true);
    assert.equal(entregar.query.safeParse({ v: '2' }).success, true);
    assert.equal(entregar.query.safeParse({}).success, true);
    for (const ruim of [{ v: '0' }, { v: 'x' }, { x: '1' }]) assert.equal(entregar.query.safeParse(ruim).success, false, JSON.stringify(ruim));
  });

  test('CT-11 material: imagem = { origem PADRAO|EMPRESA, id } (id em texto ou inteiro seguro, vira texto), null remove só na alteração, ausente não mexe; chave extra e origem fora do enum são recusadas', () => {
    const corpoBase = E.P.CORPO_TAMANHO_UNICO('Fita nova');
    const aceita = (que, corpo) => schemasDeMaterial[que].body.safeParse(corpo);
    assert.equal(aceita('criar', { ...corpoBase, imagem: { origem: 'EMPRESA', id: E.ID_GRANDE_EMPRESA } }).success, true);
    assert.equal(aceita('criar', { ...corpoBase, imagem: { origem: 'PADRAO', id: '1001' } }).success, true);
    assert.equal(aceita('criar', corpoBase).success, true);
    assert.equal(aceita('alterar', { imagem: null }).success, true);
    assert.equal(aceita('alterar', { imagem: { origem: 'EMPRESA', id: 12 } }).data.imagem.id, '12');
    assert.equal(aceita('alterar', { imagem: { origem: 'EMPRESA', id: E.ID_GRANDE_EMPRESA } }).data.imagem.id, E.ID_GRANDE_EMPRESA);
    for (const ruim of [{ origem: 'EMPRESA' }, { origem: 'OUTRA', id: '1' }, { origem: 'empresa', id: '1' }, { origem: 'EMPRESA', id: '1', versao: 1 }, { origem: 'EMPRESA', id: '01' }, { origem: 'EMPRESA', id: 9007199254740993 }]) {
      assert.equal(aceita('alterar', { imagem: ruim }).success, false, JSON.stringify(ruim));
    }
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 CT — códigos de erro que as telas vão traduzir existem de verdade no backend', () => {
  test('CT-12 cada código usado nos testes do frontend aparece no código-fonte do backend (nenhum foi inventado)', () => {
    const arquivos = [];
    const varrer = (pasta) => {
      for (const e of fs.readdirSync(pasta, { withFileTypes: true })) {
        if (/ 2(\.[a-z]+)?$/.test(e.name)) continue;
        const caminho = path.join(pasta, e.name);
        if (e.isDirectory()) varrer(caminho); else if (e.name.endsWith('.js')) arquivos.push(caminho);
      }
    };
    varrer(path.join(BACKEND, 'src'));
    const fonte = arquivos.map((a) => fs.readFileSync(a, 'utf8')).join('\n');
    const codigos = ['IMAGEM_NAO_ENCONTRADA', 'IMAGEM_EM_USO', 'IMAGEM_COTA_EXCEDIDA', 'IMAGENS_INDISPONIVEL', 'IMAGENS_OCUPADO', 'IMAGEM_FORMATO_NAO_SUPORTADO', 'IMAGEM_ANIMADA_NAO_SUPORTADA',
      'IMAGEM_INVALIDA', 'IMAGEM_DIMENSOES_INVALIDAS', 'IMAGEM_PROCESSAMENTO_EXCEDEU_TEMPO', 'IMAGEM_SAIDA_EXCEDE_LIMITE', 'PAYLOAD_MUITO_GRANDE', 'TIPO_CONTEUDO_NAO_SUPORTADO',
      'LIMITE_REQUISICOES_EXCEDIDO', 'NOME_INVALIDO', 'VALIDACAO', 'SEM_PERMISSAO', 'NAO_AUTENTICADO', 'MATERIAL_NAO_ENCONTRADO'];
    for (const codigo of codigos) assert.ok(fonte.includes(`'${codigo}'`), `o backend não tem o código ${codigo}`);
  });
});

// ─────────────────────────────────────────────────────────────────────
describe('5C-7 CT — CORS: o que o navegador deixa o frontend enviar e ler', () => {
  test('CT-13 o portal aceita POST, PATCH e DELETE e o cabeçalho Content-Type (basta para o envio binário com image/*); NENHUM cabeçalho de resposta é exposto', () => {
    for (const metodo of ['GET', 'POST', 'PATCH', 'DELETE']) assert.ok(METODOS_PORTAL.includes(metodo), metodo);
    const fonte = ler('src/middleware/cors.js');
    assert.match(fonte, /allowedHeaders:\s*\['Content-Type'\]/);
  });

  test('CT-14 sem exposedHeaders, o Retry-After só é legível pelo JavaScript quando a página e a API são da MESMA origem: a espera sugerida é opcional na interface (null em desenvolvimento entre portas diferentes)', () => {
    assert.equal(/exposedHeaders/.test(ler('src/middleware/cors.js')), false);
  });
});
