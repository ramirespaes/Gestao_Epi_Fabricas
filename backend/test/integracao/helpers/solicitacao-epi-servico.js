'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {
  inserir, criarEmpresa, criarGhe, criarFuncionario, criarMaterial,
} = require('./entrega-epi');
const { CNPJ_A, CNPJ_B } = require('./solicitacao-epi');
const { HttpError } = require('../../../src/errors/HttpError');

/**
 * Mundo de dados da camada de negócio da solicitação de EPI (12B): duas
 * empresas, usuários de perfis diferentes (quem pede, quem decide, MASTER),
 * trabalhadores ativos e inativo, GHE com matriz, e um material de cada
 * classificação de tamanho. Só dados fictícios.
 */

async function inserirUsuario(executor, empresaId, email, perfil = 'USUARIO', { ativo = true } = {}) {
  const usuario = await inserir(executor, 'usuarios', {
    empresa_id: empresaId, nome: `Usuário ${email}`, email, senha_hash: 'hash-de-teste', perfil, ativo,
  });
  return usuario.id;
}

async function vincularMaterialAoGhe(executor, empresaId, gheId, materialId) {
  await inserir(executor, 'ghe_materiais', { empresa_id: empresaId, grupo_homogeneo_id: gheId, material_id: materialId });
}

async function montarMundoDoServico(pool) {
  const d = { CNPJ_A, CNPJ_B };
  d.empresaA = await criarEmpresa(pool, CNPJ_A, 'Empresa A Fictícia');
  d.empresaB = await criarEmpresa(pool, CNPJ_B, 'Empresa B Fictícia');

  d.solicitante = await inserirUsuario(pool, d.empresaA, 'solicitante-a@example.invalid', 'USUARIO');
  d.outroSolicitante = await inserirUsuario(pool, d.empresaA, 'outro-a@example.invalid', 'USUARIO');
  d.sst1 = await inserirUsuario(pool, d.empresaA, 'sst1-a@example.invalid', 'ADMINISTRADOR');
  d.sst2 = await inserirUsuario(pool, d.empresaA, 'sst2-a@example.invalid', 'ADMINISTRADOR');
  d.master = await inserirUsuario(pool, d.empresaA, 'master-a@example.invalid', 'MASTER');
  d.master2 = await inserirUsuario(pool, d.empresaA, 'master2-a@example.invalid', 'MASTER');
  d.usuarioInativo = await inserirUsuario(pool, d.empresaA, 'inativo-a@example.invalid', 'USUARIO', { ativo: false });
  d.masterInativo = await inserirUsuario(pool, d.empresaA, 'master-inativo-a@example.invalid', 'MASTER', { ativo: false });
  d.usuarioB = await inserirUsuario(pool, d.empresaB, 'usuario-b@example.invalid', 'USUARIO');
  d.masterB = await inserirUsuario(pool, d.empresaB, 'master-b@example.invalid', 'MASTER');
  d.sstB = await inserirUsuario(pool, d.empresaB, 'sst-b@example.invalid', 'ADMINISTRADOR');

  d.gheA = await criarGhe(pool, d.empresaA, 'GHE A');
  d.gheA2 = await criarGhe(pool, d.empresaA, 'GHE A2');
  d.gheB = await criarGhe(pool, d.empresaB, 'GHE B');

  d.botina = await criarMaterial(pool, d.empresaA, 'Botina de segurança', { exigeTamanho: true });
  d.capacete = await criarMaterial(pool, d.empresaA, 'Capacete', { exigeTamanho: false });
  d.luva = await criarMaterial(pool, d.empresaA, 'Luva de raspa', { exigeTamanho: true });
  d.protetor = await criarMaterial(pool, d.empresaA, 'Protetor auricular', { exigeTamanho: false });
  d.naoClassificado = await criarMaterial(pool, d.empresaA, 'Material sem classificação de tamanho', { exigeTamanho: null });
  d.inativo = await criarMaterial(pool, d.empresaA, 'Material inativo', { exigeTamanho: true, ativo: false });
  d.botinaB = await criarMaterial(pool, d.empresaB, 'Botina B', { exigeTamanho: true });

  // Matriz: botina e capacete são previstos no GHE A; luva e protetor não.
  await vincularMaterialAoGhe(pool, d.empresaA, d.gheA, d.botina);
  await vincularMaterialAoGhe(pool, d.empresaA, d.gheA, d.capacete);
  await vincularMaterialAoGhe(pool, d.empresaA, d.gheA2, d.luva);

  let cpf = 10000000000;
  const proximoCpf = () => String(cpf++);
  let matricula = 0;
  const trabalhador = (empresaId, opcoes = {}) => {
    matricula += 1;
    return criarFuncionario(pool, empresaId, { matricula: `T-${matricula}`, cpf: proximoCpf(), ...opcoes });
  };
  d.trabalhador = await trabalhador(d.empresaA, { gheId: d.gheA });
  d.trabalhador2 = await trabalhador(d.empresaA, { gheId: d.gheA });
  d.trabalhador3 = await trabalhador(d.empresaA, { gheId: d.gheA });
  d.trabalhadorSemGhe = await trabalhador(d.empresaA);
  d.trabalhadorInativo = await trabalhador(d.empresaA, { gheId: d.gheA, ativo: false });
  d.trabalhadorB = await trabalhador(d.empresaB, { gheId: d.gheB });
  d.novoTrabalhador = trabalhador;
  return d;
}

const chaveNova = () => crypto.randomUUID();

async function esperarHttpError(promessa, status, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.deepEqual([erro.status, erro.codigo], [status, codigo], erro.message);
    return true;
  });
}

async function esperarValidacao(promessa, campo, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.deepEqual([erro.status, erro.codigo], [400, 'VALIDACAO']);
    assert.ok(erro.detalhes.some((x) => x.campo === campo && x.codigo === codigo), JSON.stringify(erro.detalhes));
    return true;
  });
}

// Pausa a primeira chamada de modulo[fn] até liberar(); as demais passam direto.
function portao(t, modulo, fn) {
  const original = modulo[fn];
  let liberar;
  let chegou;
  const espera = new Promise((resolve) => { liberar = resolve; });
  const chegada = new Promise((resolve) => { chegou = resolve; });
  let primeira = true;
  t.mock.method(modulo, fn, async (...args) => {
    if (primeira) {
      primeira = false;
      chegou();
      await espera;
    }
    return original(...args);
  });
  return { liberar, chegada };
}

// Espera, no PostgreSQL, uma trava advisory pedida e ainda não concedida (alguém esperando por outra transação).
async function aguardarTravaAdvisoryPendente(pool, { tentativas = 300, intervaloMs = 10 } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    const { rows: [{ n }] } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory' AND NOT granted AND database = (SELECT oid FROM pg_database WHERE datname = current_database())",
    );
    if (n > 0) return n;
    await new Promise((resolve) => { setTimeout(resolve, intervaloMs); });
  }
  throw new Error('nenhuma trava advisory ficou esperando dentro do tempo esperado');
}

// Espera uma consulta que bloqueia por trava de linha ou de transação.
async function aguardarEsperaPorTravaDeLinha(pool, { tentativas = 300, intervaloMs = 10 } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    const { rows: [{ n }] } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock' AND wait_event IN ('transactionid', 'tuple')",
    );
    if (n > 0) return n;
    await new Promise((resolve) => { setTimeout(resolve, intervaloMs); });
  }
  throw new Error('nenhuma transação ficou esperando por trava de linha dentro do tempo esperado');
}

const comLimite = (promessa, rotulo, ms = 4000) => Promise.race([
  promessa,
  new Promise((_, rejeitar) => { setTimeout(() => rejeitar(new Error(`${rotulo}: não resolveu em ${ms} ms`)), ms); }),
]);

module.exports = {
  inserirUsuario, vincularMaterialAoGhe, montarMundoDoServico, chaveNova, esperarHttpError, esperarValidacao, portao,
  aguardarTravaAdvisoryPendente, aguardarEsperaPorTravaDeLinha, comLimite,
};
