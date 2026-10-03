'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { exigirModulo } = require('../helpers/exigir-modulo');
const { todasAsMigrations, inserir } = require('./helpers/entrega-epi');
const { montarMundoDoServico, inserirUsuario, esperarHttpError } = require('./helpers/solicitacao-epi-servico');

/**
 * Listagem dos vínculos SST (12E-1) contra PostgreSQL real: só o MASTER ativo
 * da própria empresa lista, como já só ele concede e remove; isolamento entre
 * empresas, ordem, paginação, vínculos de usuário inativo e de MASTER legado
 * visíveis para a limpeza, nenhum dado de credencial ou contato, e leitura
 * sem escrita nem auditoria.
 */

const servico = () => exigirModulo('src/services/vinculo-sst.service');
const funcao = () => {
  assert.equal(typeof servico().listarVinculos, 'function', 'função ainda não implementada: listarVinculos');
  return servico().listarVinculos;
};

describe('listagem dos vínculos SST — serviço (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let d;
  let inativado;

  const q = (sql, params) => pool.query(sql, params);
  const listar = (extra = {}) => funcao()(pool, {
    empresaId: d.empresaA, atorId: d.master, pagina: 1, limite: 100, ...extra,
  });
  const fotoDeEscrita = async () => (await q(
    'SELECT (SELECT count(*)::int FROM vinculo_sst) AS vinculos, (SELECT count(*)::int FROM logs_auditoria) AS auditoria',
  )).rows[0];

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    d = await montarMundoDoServico(pool);
    const conceder = (empresaId, atorId, usuarioId, motivo) => servico().concederVinculo(pool, { empresaId, atorId, usuarioId, motivo });
    await conceder(d.empresaA, d.master, d.sst1, 'Técnico de segurança');
    await conceder(d.empresaA, d.master, d.sst2);
    inativado = await inserirUsuario(pool, d.empresaA, 'sst-inativado@example.invalid', 'ADMINISTRADOR');
    await conceder(d.empresaA, d.master, inativado, 'Será inativado');
    await q('UPDATE usuarios SET ativo = false WHERE id = $1', [inativado]);
    await inserir(pool, 'vinculo_sst', { empresa_id: d.empresaA, usuario_id: d.master2, concedido_por: d.master, motivo: 'Legado' });
    await conceder(d.empresaB, d.masterB, d.sstB);
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('o MASTER ativo lista os vínculos da própria empresa, do mais novo ao mais antigo, com quem concedeu, quando e o motivo', async () => {
    const lista = await listar();
    assert.deepEqual(lista.vinculos.map((v) => v.usuarioId), [d.master2, inativado, d.sst2, d.sst1]);
    assert.deepEqual([lista.total, lista.pagina, lista.limite], [4, 1, 100]);
    const sst1 = lista.vinculos.find((v) => v.usuarioId === d.sst1);
    assert.deepEqual([sst1.concedidoPor, sst1.motivo], [d.master, 'Técnico de segurança']);
    assert.ok(sst1.concedidoEm instanceof Date);
    assert.equal(lista.vinculos.find((v) => v.usuarioId === d.sst2).motivo, null);
  });

  test('cada vínculo traz nome, perfil e situação do usuário; o inativo e o MASTER legado aparecem, para a limpeza', async () => {
    const lista = await listar();
    const por = new Map(lista.vinculos.map((v) => [v.usuarioId, v]));
    assert.deepEqual(por.get(inativado).usuario, { nome: `Usuário sst-inativado@example.invalid`, perfil: 'ADMINISTRADOR', ativo: false });
    assert.deepEqual(por.get(d.master2).usuario.perfil, 'MASTER');
    assert.deepEqual(por.get(d.sst1).usuario, { nome: 'Usuário sst1-a@example.invalid', perfil: 'ADMINISTRADOR', ativo: true });
    for (const v of lista.vinculos) {
      assert.deepEqual(Object.keys(v).sort(), ['concedidoEm', 'concedidoPor', 'motivo', 'usuario', 'usuarioId']);
      assert.deepEqual(Object.keys(v.usuario).sort(), ['ativo', 'nome', 'perfil']);
    }
  });

  test('nenhum e-mail, hash, CPF, empresa ou credencial na resposta', async () => {
    const texto = JSON.stringify(await listar());
    for (const proibido of ['senha', 'hash-de-teste', 'cpf', 'empresaId', '"email"']) assert.equal(texto.includes(proibido), false, proibido);
  });

  test('paginação: páginas consecutivas reconstroem a lista, o total é estável e além da última vem vazia', async () => {
    const inteira = (await listar()).vinculos.map((v) => v.usuarioId);
    const p1 = await listar({ pagina: 1, limite: 3 });
    const p2 = await listar({ pagina: 2, limite: 3 });
    assert.deepEqual([p1.vinculos.length, p2.vinculos.length], [3, 1]);
    assert.ok([p1, p2].every((p) => p.total === 4 && p.limite === 3));
    assert.deepEqual([...p1.vinculos, ...p2.vinculos].map((v) => v.usuarioId), inteira);
    const alem = await listar({ pagina: 3, limite: 3 });
    assert.deepEqual([alem.vinculos.length, alem.total], [0, 4]);
  });

  test('só o MASTER ativo da própria empresa: administrador com vínculo SST, usuário comum, MASTER inativo, ator inexistente e MASTER de outra empresa recebem o mesmo 403', async () => {
    const atores = [
      ['administrador com vínculo SST', d.sst1],
      ['usuário comum', d.solicitante],
      ['MASTER inativo', d.masterInativo],
      ['ator inexistente', 987654321],
      ['MASTER de outra empresa', d.masterB],
    ];
    const respostas = [];
    for (const [rotulo, atorId] of atores) {
      await esperarHttpError(listar({ atorId }), 403, 'SEM_AUTORIDADE_VINCULO_SST');
      try {
        await listar({ atorId });
      } catch (erro) {
        respostas.push([rotulo, erro.status, erro.codigo, erro.message]);
      }
    }
    assert.equal(new Set(respostas.map(([, status, codigo, mensagem]) => `${status}|${codigo}|${mensagem}`)).size, 1);
  });

  test('isolamento: o MASTER de cada empresa vê só os vínculos dela', async () => {
    const daB = await funcao()(pool, { empresaId: d.empresaB, atorId: d.masterB, pagina: 1, limite: 100 });
    assert.deepEqual(daB.vinculos.map((v) => v.usuarioId), [d.sstB]);
    assert.equal(daB.total, 1);
    const daA = await listar();
    assert.equal(daA.vinculos.some((v) => v.usuarioId === d.sstB), false);
  });

  test('leitura pura: nenhum vínculo muda e nenhuma auditoria é criada', async () => {
    const antes = await fotoDeEscrita();
    await listar();
    await listar({ pagina: 2, limite: 1 });
    await listar({ atorId: d.sst1 }).catch(() => null);
    assert.deepEqual(await fotoDeEscrita(), antes);
  });
});
