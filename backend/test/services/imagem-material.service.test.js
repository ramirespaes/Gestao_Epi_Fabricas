'use strict';

const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { exigirModulo } = require('../helpers/exigir-modulo');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');

/**
 * Biblioteca de Imagens, Unidade 3 (RED) — serviço da BIBLIOTECA, sem PostgreSQL (repositórios substituídos por t.mock.method; só BEGIN/COMMIT/
 * ROLLBACK passam pelo cliente falso). Aqui só o que o banco real não prova bem: ORDEM das operações (a trava da biblioteca ANTES da busca por
 * SHA-256), empresa sempre do contexto, transação com ROLLBACK, auditoria só com ids, e a ausência de qualquer decisão de autorização (que mora
 * no middleware do recurso `materials`, como em material.service.js). O comportamento com banco está em imagem-material-biblioteca.integration.js.
 */

const servico = () => exigirModulo('src/services/imagem-material.service');
const repoEmpresa = () => exigirModulo('src/repositories/imagem-empresa.repository');
const EMPRESA = 42;
const ATOR = 7;
const HEX = (c) => c.repeat(64);

const descritor = (extra = {}) => ({
  sha256: HEX('a'), sha256Mestre: HEX('b'), sha256Exibicao: HEX('c'), sha256Miniatura: HEX('d'), formato: 'PNG', largura: 1024, altura: 1024,
  bytesMestre: 90000, bytesExibicao: 40000, bytesMiniatura: 9000, ...extra,
});
const imagem = (extra = {}) => ({
  id: '5', empresaId: EMPRESA, nome: 'Imagem', sha256: HEX('a'), formato: 'PNG', largura: 1024, altura: 1024, versao: 1, estado: 'ATIVA', criadoPor: ATOR,
  bytesMestre: 90000, bytesExibicao: 40000, bytesMiniatura: 9000, ...extra,
});

function clienteFalso(ordem) {
  return {
    query: async (texto) => { ordem.push(texto); return { rows: [], rowCount: 0 }; },
    release: () => { ordem.push('RELEASE'); },
  };
}
const poolFalso = (cliente) => ({ connect: async () => cliente, query: (...a) => cliente.query(...a) });

/** Substitui todos os repositórios tocados pelo serviço, registrando a ordem das chamadas em `ordem`. */
function mundo(t, ordem, { existente = null, consumo = { imagens: 0, bytes: 0 }, uso = 0, falhaNoInserir = null } = {}) {
  const r = repoEmpresa();
  const gravar = (nome, resultado) => async (...args) => { ordem.push(nome); return typeof resultado === 'function' ? resultado(...args) : resultado; };
  return {
    travar: t.mock.method(r, 'travarBiblioteca', gravar('travar', undefined)),
    porSha: t.mock.method(r, 'buscarPorSha256', gravar('porSha', existente)),
    consumo: t.mock.method(r, 'somarConsumo', gravar('consumo', consumo)),
    inserir: t.mock.method(r, 'inserir', async (...a) => { ordem.push('inserir'); if (falhaNoInserir) throw falhaNoInserir; return imagem({ ...a[1], id: '5' }); }),
    paraAtualizacao: t.mock.method(r, 'buscarPorIdParaAtualizacao', gravar('paraAtualizacao', existente)),
    uso: t.mock.method(r, 'contarUso', gravar('uso', uso)),
    estado: t.mock.method(r, 'atualizarEstado', async (_c, _e, _id, estado) => { ordem.push('estado'); return imagem({ estado }); }),
    nome: t.mock.method(r, 'atualizarNome', async (_c, _e, _id, nome) => { ordem.push('nome'); return imagem({ nome }); }),
    auditoria: t.mock.method(auditoriaRepo, 'registrar', async () => { ordem.push('auditoria'); return { id: '1', criadoEm: new Date() }; }),
  };
}
const aoCliente = (ordem) => ordem.filter((o) => !['RELEASE'].includes(o));

async function esperarHttp(promessa, status, codigo) {
  await assert.rejects(promessa, (e) => { assert.equal(e.status, status); assert.equal(e.codigo, codigo); return true; });
}

describe('registrarEmpresa — ordem, isolamento e transação', () => {
  test('ordem: BEGIN, trava da biblioteca, busca por SHA-256, cota, INSERT, auditoria, COMMIT (a trava vem ANTES de qualquer leitura de deduplicação ou cota)', async (t) => {
    const ordem = [];
    mundo(t, ordem);
    await servico().registrarEmpresa(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Imagem', imagem: descritor() });
    assert.deepEqual(aoCliente(ordem), ['BEGIN', 'travar', 'porSha', 'consumo', 'inserir', 'auditoria', 'COMMIT']);
  });

  test('toda chamada a repositório leva a empresa do CONTEXTO (nunca a do descritor) e o ator da sessão como criador', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem);
    await servico().registrarEmpresa(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Imagem', imagem: descritor() });
    for (const chamada of [m.travar, m.porSha, m.consumo]) assert.equal(chamada.mock.calls[0].arguments[1], EMPRESA);
    const dados = m.inserir.mock.calls[0].arguments[1];
    assert.deepEqual([dados.empresaId, dados.criadoPor], [EMPRESA, ATOR]);
    assert.equal(m.auditoria.mock.calls[0].arguments[1].empresaId, EMPRESA);
    assert.equal(m.auditoria.mock.calls[0].arguments[1].usuarioId, ATOR);
  });

  test('o descritor é estrito: chave a mais (empresaId, criadoPor, caminho, chave, estado, versao) é 400 e nada é consultado nem aberto', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem);
    for (const extra of [{ empresaId: 99 }, { criadoPor: 1 }, { caminho: '/x' }, { chave: 'k' }, { estado: 'ATIVA' }, { versao: 9 }, { id: 3 }]) {
      await esperarHttp(servico().registrarEmpresa(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Imagem', imagem: descritor(extra) }), 400, 'VALIDACAO');
    }
    assert.deepEqual(ordem, [], 'nenhuma conexão aberta');
    assert.equal(m.inserir.mock.calls.length, 0);
  });

  test('imagem já existente: devolve a existente (reaproveitada) SEM cota, SEM INSERT e SEM auditoria, e fecha a transação com COMMIT', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem, { existente: imagem({ id: 11, nome: 'Já existia' }) });
    const r = await servico().registrarEmpresa(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Outro', imagem: descritor() });
    assert.deepEqual([r.reaproveitada, r.imagem.id, r.imagem.nome], [true, 11, 'Já existia']);
    assert.deepEqual(aoCliente(ordem), ['BEGIN', 'travar', 'porSha', 'COMMIT']);
    assert.equal(m.auditoria.mock.calls.length, 0);
  });

  test('cota: o padrão vem da configuração (300 imagens / 300 MiB); estourar é 409 IMAGEM_COTA_EXCEDIDA com ROLLBACK e sem INSERT nem auditoria; `limites` explícitos prevalecem', async (t) => {
    const cheia = [];
    const m = mundo(t, cheia, { consumo: { imagens: 300, bytes: 0 } });
    await esperarHttp(servico().registrarEmpresa(poolFalso(clienteFalso(cheia)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Imagem', imagem: descritor() }), 409, 'IMAGEM_COTA_EXCEDIDA');
    assert.deepEqual(aoCliente(cheia).slice(-1), ['ROLLBACK']);
    assert.equal(m.inserir.mock.calls.length, 0);
    assert.equal(m.auditoria.mock.calls.length, 0);
    const bytes = [];
    // A cota em bytes é a dos MESTRES (docs. 04 e 13): faltam 50000 bytes e o mestre novo tem 90000.
    mundo(t, bytes, { consumo: { imagens: 1, bytes: 300 * 1024 * 1024 - 50000 } });
    await esperarHttp(servico().registrarEmpresa(poolFalso(clienteFalso(bytes)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Imagem', imagem: descritor() }), 409, 'IMAGEM_COTA_EXCEDIDA');
    const livre = [];
    mundo(t, livre, { consumo: { imagens: 299, bytes: 0 } });
    assert.equal((await servico().registrarEmpresa(poolFalso(clienteFalso(livre)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Imagem', imagem: descritor() })).reaproveitada, false);
    const ajustada = [];
    mundo(t, ajustada, { consumo: { imagens: 3, bytes: 0 } });
    await esperarHttp(servico().registrarEmpresa(poolFalso(clienteFalso(ajustada)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Imagem', imagem: descritor(), limites: { cotaImagens: 3, cotaBytes: 1e12 } }), 409, 'IMAGEM_COTA_EXCEDIDA');
  });

  test('falha em qualquer passo (INSERT, auditoria) = ROLLBACK, a conexão é devolvida e o erro original propaga sem ser engolido', async (t) => {
    const erro = Object.assign(new Error('falha do banco'), { code: '57P01' });
    const ordem = [];
    mundo(t, ordem, { falhaNoInserir: erro });
    await assert.rejects(servico().registrarEmpresa(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Imagem', imagem: descritor() }), (e) => e === erro);
    assert.deepEqual(aoCliente(ordem).slice(-1), ['ROLLBACK']);
    assert.equal(ordem.at(-1), 'RELEASE');
  });

  test('auditoria: ação IMAGEM_MATERIAL_IMPORTADA, referência = id, contexto só com ids, formato e bytes (nunca nome, hash, chave ou caminho)', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem);
    await servico().registrarEmpresa(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, nome: 'Nome secreto', imagem: descritor(), ip: '203.0.113.1', dispositivo: 'agente' });
    const a = m.auditoria.mock.calls[0].arguments[1];
    assert.equal(a.acao, 'IMAGEM_MATERIAL_IMPORTADA');
    assert.equal(a.referencia, '5');
    assert.deepEqual(a.contexto, { imagemId: '5', formato: 'PNG', bytes: 139000 }, 'o id BIGINT circula como texto; bytes = os três arquivos armazenados');
    const bruto = JSON.stringify(a);
    for (const proibido of ['Nome secreto', HEX('a'), HEX('b'), HEX('c'), HEX('d')]) assert.equal(bruto.includes(proibido), false);
  });
});

describe('inativar, reativar e renomear — ordem de travas e uniformidade', () => {
  test('inativar: BEGIN, FOR UPDATE da imagem, contagem de uso, UPDATE de estado, auditoria, COMMIT; em uso é 409 IMAGEM_EM_USO sem escrever nem auditar', async (t) => {
    const livre = [];
    mundo(t, livre, { existente: imagem(), uso: 0 });
    await servico().inativar(poolFalso(clienteFalso(livre)), { empresaId: EMPRESA, atorId: ATOR, imagemId: 5 });
    assert.deepEqual(aoCliente(livre), ['BEGIN', 'paraAtualizacao', 'uso', 'estado', 'auditoria', 'COMMIT']);
    const emUso = [];
    const m = mundo(t, emUso, { existente: imagem(), uso: 2 });
    await esperarHttp(servico().inativar(poolFalso(clienteFalso(emUso)), { empresaId: EMPRESA, atorId: ATOR, imagemId: 5 }), 409, 'IMAGEM_EM_USO');
    assert.deepEqual(aoCliente(emUso), ['BEGIN', 'paraAtualizacao', 'uso', 'ROLLBACK']);
    assert.equal(m.estado.mock.calls.length, 0);
    assert.equal(m.auditoria.mock.calls.length, 0);
  });

  test('inexistente (ou de outra empresa — o repositório filtra pela empresa) é 404 IMAGEM_NAO_ENCONTRADA em renomear, inativar e reativar, sem escrever', async (t) => {
    for (const operacao of ['renomear', 'inativar', 'reativar']) {
      const ordem = [];
      const m = mundo(t, ordem, { existente: null });
      await esperarHttp(servico()[operacao](poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, imagemId: 5, nome: 'x' }), 404, 'IMAGEM_NAO_ENCONTRADA');
      assert.equal(m.paraAtualizacao.mock.calls[0].arguments[1], EMPRESA, operacao);
      assert.equal(m.estado.mock.calls.length + m.nome.mock.calls.length + m.auditoria.mock.calls.length, 0);
    }
  });

  test('idempotência: pedir o estado (ou o nome) que a imagem já tem não grava nem audita e devolve alterado=false', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem, { existente: imagem({ estado: 'INATIVA', nome: 'Igual' }) });
    const i = await servico().inativar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, imagemId: 5 });
    const n = await servico().renomear(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, imagemId: 5, nome: 'Igual' });
    assert.deepEqual([i.alterado, n.alterado], [false, false]);
    assert.equal(m.estado.mock.calls.length + m.nome.mock.calls.length + m.auditoria.mock.calls.length, 0);
  });

  test('reativar não consulta uso (reativar nunca é bloqueado) e audita IMAGEM_MATERIAL_REATIVADA só com o id', async (t) => {
    const ordem = [];
    const m = mundo(t, ordem, { existente: imagem({ estado: 'INATIVA' }) });
    await servico().reativar(poolFalso(clienteFalso(ordem)), { empresaId: EMPRESA, atorId: ATOR, imagemId: 5 });
    assert.equal(m.uso.mock.calls.length, 0);
    assert.equal(m.auditoria.mock.calls[0].arguments[1].acao, 'IMAGEM_MATERIAL_REATIVADA');
    assert.equal(m.auditoria.mock.calls[0].arguments[1].referencia, '5');
  });
});

describe('o serviço não decide autorização', () => {
  test('o texto do serviço não consulta perfil, MASTER, autoridade administrativa nem permissões: quem decide é o middleware do recurso materials', () => {
    const caminho = path.join(__dirname, '..', '..', 'src', 'services', 'imagem-material.service.js');
    assert.equal(fs.existsSync(caminho), true, 'módulo ainda não implementado: src/services/imagem-material.service.js');
    const texto = fs.readFileSync(caminho, 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    for (const proibido of [/perfil/i, /MASTER/, /autoridade-administrativa/, /usuario\.repository/, /avaliarPermissao/, /permissao/i]) assert.equal(proibido.test(texto), false, `decisão de autorização no serviço: ${proibido}`);
  });

  test('empresa e ator inválidos são erro de programação (TypeError) em todas as operações, antes de abrir conexão', async (t) => {
    const ordem = [];
    mundo(t, ordem);
    const pool = poolFalso(clienteFalso(ordem));
    for (const [operacao, base] of [['registrarEmpresa', { nome: 'x', imagem: descritor() }], ['renomear', { imagemId: 5, nome: 'x' }], ['inativar', { imagemId: 5 }], ['reativar', { imagemId: 5 }]]) {
      await assert.rejects(servico()[operacao](pool, { empresaId: '42', atorId: ATOR, ...base }), TypeError, operacao);
      await assert.rejects(servico()[operacao](pool, { empresaId: EMPRESA, atorId: 0, ...base }), TypeError, operacao);
    }
    assert.deepEqual(ordem, []);
  });
});
