'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirPoolTemporario } = require('./helpers/schema-temporario');
const { criarEmpresa } = require('./helpers/entrega-epi');
const { todasAsMigrations, HASH_SENHA_FICTICIO, hashDeToken, criarIdentidade, criarAdministrador } = require('./helpers/recuperacao-senha');
const identidadeRepo = require('../../src/repositories/identidade.repository');
const administradorRepo = require('../../src/repositories/administrador-plataforma.repository');
const sessaoGlobalRepo = require('../../src/repositories/sessao-global.repository');
const sessaoRepo = require('../../src/repositories/sessao.repository');

/**
 * Primitivas do ciclo de senha em repositórios já existentes, contra
 * PostgreSQL real: gravar o hash novo (identidade e administrador) e revogar
 * todas as sessões de uma identidade ligada a mais de uma empresa. Schema
 * temporário com todas as migrations.
 */

const HASH_NOVO = '$argon2id$v=19$m=65536,t=3,p=1$c2FsLW5vdm8tZmljdGljaW8$aGFzaC1ub3ZvLWZpY3RpY2lvLWRlLXRlc3Rl';
const CNPJS = ['11222333000181', '44555666000162', '22333444000100'];

describe('atualizarSenhaHash — PostgreSQL real', () => {
  let contexto;
  let pool;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('identidade: só senha_hash muda (atualizado_em pelo gatilho); e-mail, situação, vínculos e outras identidades ficam iguais', async () => {
    const empresa = await criarEmpresa(pool, CNPJS[0], 'Empresa Alfa');
    const alvo = await criarIdentidade(pool, 'alvo@example.invalid');
    const outra = await criarIdentidade(pool, 'outra@example.invalid');
    const { rows: [vinculo] } = await pool.query(
      "INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Pessoa Alvo', NULL, NULL, 'USUARIO', $2) RETURNING *", [empresa, alvo],
    );
    const antes = (await pool.query('SELECT * FROM identidades ORDER BY id')).rows;

    const r = await identidadeRepo.atualizarSenhaHash(pool, alvo, HASH_NOVO);
    assert.equal(r.id, alvo);
    assert.ok(r.atualizadoEm instanceof Date);

    const depois = (await pool.query('SELECT * FROM identidades ORDER BY id')).rows;
    const [alvoAntes, outraAntes] = [antes.find((i) => i.id === alvo), antes.find((i) => i.id === outra)];
    const [alvoDepois, outraDepois] = [depois.find((i) => i.id === alvo), depois.find((i) => i.id === outra)];
    assert.equal(alvoAntes.senha_hash, HASH_SENHA_FICTICIO);
    assert.equal(alvoDepois.senha_hash, HASH_NOVO, 'o hash chega pronto e é gravado como veio');
    assert.deepEqual(
      [alvoDepois.email, alvoDepois.ativo, alvoDepois.criado_em.getTime()],
      [alvoAntes.email, alvoAntes.ativo, alvoAntes.criado_em.getTime()],
    );
    assert.equal(r.atualizadoEm.getTime(), alvoDepois.atualizado_em.getTime());
    assert.deepEqual(outraDepois, outraAntes, 'outra identidade intocada');
    const { rows: [vinculoDepois] } = await pool.query('SELECT * FROM usuarios WHERE id = $1', [vinculo.id]);
    assert.deepEqual(vinculoDepois, vinculo, 'vínculo empresarial intocado');
  });

  test('identidade inexistente devolve null e não altera ninguém', async () => {
    const antes = (await pool.query('SELECT id, senha_hash FROM identidades ORDER BY id')).rows;
    assert.equal(await identidadeRepo.atualizarSenhaHash(pool, 999999, HASH_NOVO), null);
    assert.deepEqual((await pool.query('SELECT id, senha_hash FROM identidades ORDER BY id')).rows, antes);
  });

  test('administrador: só senha_hash muda; nenhuma linha de MFA, desafio ou sessão da plataforma é criada, alterada ou removida', async () => {
    const alvo = await criarAdministrador(pool, 'admin-alvo@example.invalid');
    const outro = await criarAdministrador(pool, 'admin-outro@example.invalid');
    const tabelasMfa = [
      'fatores_mfa_plataforma', 'lotes_recuperacao_mfa_plataforma', 'codigos_recuperacao_mfa_plataforma',
      'desafios_mfa_plataforma', 'liberacoes_cadastro_mfa_plataforma', 'sessoes_plataforma',
    ];
    const contagens = async () => {
      const saida = {};
      for (const tabela of tabelasMfa) saida[tabela] = (await pool.query(`SELECT count(*)::int AS n FROM ${tabela}`)).rows[0].n;
      return saida;
    };
    const mfaAntes = await contagens();
    const antes = (await pool.query('SELECT * FROM administradores_plataforma ORDER BY id')).rows;

    const r = await administradorRepo.atualizarSenhaHash(pool, alvo, HASH_NOVO);
    assert.equal(r.id, alvo);
    assert.ok(r.atualizadoEm instanceof Date);

    const depois = (await pool.query('SELECT * FROM administradores_plataforma ORDER BY id')).rows;
    const alvoDepois = depois.find((a) => a.id === alvo);
    const alvoAntes = antes.find((a) => a.id === alvo);
    assert.equal(alvoDepois.senha_hash, HASH_NOVO);
    assert.deepEqual([alvoDepois.email, alvoDepois.ativo], [alvoAntes.email, alvoAntes.ativo]);
    assert.deepEqual(depois.find((a) => a.id === outro), antes.find((a) => a.id === outro), 'outro administrador intocado');
    assert.deepEqual(await contagens(), mfaAntes, 'MFA, desafios e sessões da plataforma intocados');
    assert.equal(await administradorRepo.atualizarSenhaHash(pool, 999999, HASH_NOVO), null);
  });

  test('usa o executor recebido: troca feita numa transação desfeita não persiste', async () => {
    const id = await criarIdentidade(pool, 'transacao@example.invalid');
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await identidadeRepo.atualizarSenhaHash(cliente, id, HASH_NOVO);
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
    const { rows: [{ senha_hash }] } = await pool.query('SELECT senha_hash FROM identidades WHERE id = $1', [id]);
    assert.equal(senha_hash, HASH_SENHA_FICTICIO);
  });
});

describe('revogarTodasDaIdentidade — identidade ligada a mais de uma empresa, PostgreSQL real', () => {
  let contexto;
  let pool;
  let etapa = 0;

  /**
   * Monta uma identidade com vínculo em duas empresas, duas sessões globais
   * (a atual e a de outro aparelho), sessões empresariais nascidas de cada
   * uma — inclusive duas da sessão global atual, em empresas diferentes —,
   * uma sessão empresarial sem sessão global e uma já revogada. Também cria
   * outra identidade, com sessões que nunca podem ser atingidas.
   */
  async function cenario() {
    etapa += 1;
    const d = {};
    d.identidade = await criarIdentidade(pool, `pessoa${etapa}@example.invalid`);
    d.outraIdentidade = await criarIdentidade(pool, `vizinha${etapa}@example.invalid`);
    const usuario = async (empresaId, identidadeId) => (await pool.query(
      "INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, identidade_id) VALUES ($1, 'Pessoa', NULL, NULL, 'USUARIO', $2) RETURNING id", [empresaId, identidadeId],
    )).rows[0].id;
    const global = async (identidadeId) => (await pool.query(
      "INSERT INTO sessoes_globais (identidade_id, token_hash, expira_em) VALUES ($1, $2, now() + interval '1 hour') RETURNING id", [identidadeId, hashDeToken()],
    )).rows[0].id;
    const empresarial = async (empresaId, usuarioId, sessaoGlobalId) => (await pool.query(
      "INSERT INTO sessoes (empresa_id, usuario_id, token_hash, expira_em, sessao_global_id) VALUES ($1, $2, $3, now() + interval '1 hour', $4) RETURNING id",
      [empresaId, usuarioId, hashDeToken(), sessaoGlobalId],
    )).rows[0].id;

    d.usuarioA = await usuario(empresas[0], d.identidade);
    d.usuarioB = await usuario(empresas[1], d.identidade);
    d.usuarioVizinho = await usuario(empresas[0], d.outraIdentidade);

    d.globalAtual = await global(d.identidade);
    d.globalOutroAparelho = await global(d.identidade);
    d.globalVizinha = await global(d.outraIdentidade);

    d.empresarialAtualA = await empresarial(empresas[0], d.usuarioA, d.globalAtual);
    d.empresarialMesmaGlobalB = await empresarial(empresas[1], d.usuarioB, d.globalAtual);
    d.empresarialOutroAparelhoA = await empresarial(empresas[0], d.usuarioA, d.globalOutroAparelho);
    d.empresarialOutroAparelhoB = await empresarial(empresas[1], d.usuarioB, d.globalOutroAparelho);
    d.empresarialSemGlobalB = await empresarial(empresas[1], d.usuarioB, null);
    d.empresarialVizinha = await empresarial(empresas[0], d.usuarioVizinho, d.globalVizinha);

    d.globalJaRevogada = await global(d.identidade);
    await pool.query("UPDATE sessoes_globais SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [d.globalJaRevogada]);
    d.empresarialJaRevogada = await empresarial(empresas[0], d.usuarioA, null);
    await pool.query("UPDATE sessoes SET revogada_em = now(), motivo_revogacao = 'LOGOUT' WHERE id = $1", [d.empresarialJaRevogada]);
    return d;
  }

  const empresas = [];
  const motivoGlobal = async (id) => (await pool.query('SELECT motivo_revogacao FROM sessoes_globais WHERE id = $1', [id])).rows[0].motivo_revogacao;
  const motivoEmpresarial = async (id) => (await pool.query('SELECT motivo_revogacao FROM sessoes WHERE id = $1', [id])).rows[0].motivo_revogacao;

  before(async () => {
    contexto = await abrirPoolTemporario(todasAsMigrations());
    pool = contexto.pool;
    empresas.push(await criarEmpresa(pool, CNPJS[0], 'Empresa Alfa'));
    empresas.push(await criarEmpresa(pool, CNPJS[1], 'Empresa Beta'));
  });
  after(async () => { if (contexto) await contexto.encerrar(); });

  test('reset público: nenhuma sessão é preservada — todas as globais e as empresariais das duas empresas caem; outra identidade não é tocada', async () => {
    const d = await cenario();
    const globais = await sessaoGlobalRepo.revogarTodasDaIdentidade(pool, d.identidade, 'SENHA_REDEFINIDA');
    const empresariais = await sessaoRepo.revogarTodasDaIdentidade(pool, d.identidade, 'SENHA_REDEFINIDA');
    assert.deepEqual([globais, empresariais], [2, 5]);

    assert.deepEqual(
      [await motivoGlobal(d.globalAtual), await motivoGlobal(d.globalOutroAparelho)],
      ['SENHA_REDEFINIDA', 'SENHA_REDEFINIDA'],
    );
    assert.deepEqual(
      [await motivoEmpresarial(d.empresarialAtualA), await motivoEmpresarial(d.empresarialMesmaGlobalB), await motivoEmpresarial(d.empresarialOutroAparelhoA),
        await motivoEmpresarial(d.empresarialOutroAparelhoB), await motivoEmpresarial(d.empresarialSemGlobalB)],
      Array(5).fill('SENHA_REDEFINIDA'),
    );
    assert.deepEqual([await motivoGlobal(d.globalVizinha), await motivoEmpresarial(d.empresarialVizinha)], [null, null], 'outra identidade intocada');
    assert.deepEqual([await motivoGlobal(d.globalJaRevogada), await motivoEmpresarial(d.empresarialJaRevogada)], ['LOGOUT', 'LOGOUT'], 'quem já estava revogada mantém o motivo');
  });

  test('troca autenticada: preserva só a sessão global atual e a sessão empresarial atual da requisição; todo o resto cai, em todas as empresas', async () => {
    const d = await cenario();
    const globais = await sessaoGlobalRepo.revogarTodasDaIdentidade(pool, d.identidade, 'SENHA_ALTERADA', { exceto: d.globalAtual });
    const empresariais = await sessaoRepo.revogarTodasDaIdentidade(pool, d.identidade, 'SENHA_ALTERADA', { exceto: d.empresarialAtualA });
    assert.deepEqual([globais, empresariais], [1, 4]);

    assert.deepEqual([await motivoGlobal(d.globalAtual), await motivoEmpresarial(d.empresarialAtualA)], [null, null], 'contexto que fez a troca preservado');
    assert.equal(await motivoGlobal(d.globalOutroAparelho), 'SENHA_ALTERADA');
    assert.equal(await motivoEmpresarial(d.empresarialMesmaGlobalB), 'SENHA_ALTERADA', 'nascida da mesma sessão global, mas não é a sessão atual: cai');
    assert.deepEqual(
      [await motivoEmpresarial(d.empresarialOutroAparelhoA), await motivoEmpresarial(d.empresarialOutroAparelhoB), await motivoEmpresarial(d.empresarialSemGlobalB)],
      Array(3).fill('SENHA_ALTERADA'),
    );
    assert.deepEqual([await motivoGlobal(d.globalVizinha), await motivoEmpresarial(d.empresarialVizinha)], [null, null]);
  });

  test('troca autenticada sem sessão empresarial na requisição: só a sessão global atual fica; todas as empresariais caem', async () => {
    const d = await cenario();
    assert.equal(await sessaoGlobalRepo.revogarTodasDaIdentidade(pool, d.identidade, 'SENHA_ALTERADA', { exceto: d.globalAtual }), 1);
    assert.equal(await sessaoRepo.revogarTodasDaIdentidade(pool, d.identidade, 'SENHA_ALTERADA'), 5);
    assert.equal(await motivoGlobal(d.globalAtual), null);
    assert.equal(await motivoEmpresarial(d.empresarialAtualA), 'SENHA_ALTERADA');
  });

  test('a exceção só protege sessão da própria identidade: apontar para a sessão de outra pessoa não preserva nada nem a atinge', async () => {
    const d = await cenario();
    assert.equal(await sessaoRepo.revogarTodasDaIdentidade(pool, d.identidade, 'SENHA_ALTERADA', { exceto: d.empresarialVizinha }), 5);
    assert.equal(await sessaoGlobalRepo.revogarTodasDaIdentidade(pool, d.identidade, 'SENHA_ALTERADA', { exceto: d.globalVizinha }), 2);
    assert.deepEqual([await motivoGlobal(d.globalVizinha), await motivoEmpresarial(d.empresarialVizinha)], [null, null], 'outra identidade intocada');
    assert.equal(await motivoEmpresarial(d.empresarialAtualA), 'SENHA_ALTERADA');
  });

  test('repetir a revogação não atinge mais nada (idempotente) e identidade sem sessão devolve zero', async () => {
    const d = await cenario();
    await sessaoGlobalRepo.revogarTodasDaIdentidade(pool, d.identidade, 'SENHA_REDEFINIDA');
    await sessaoRepo.revogarTodasDaIdentidade(pool, d.identidade, 'SENHA_REDEFINIDA');
    assert.equal(await sessaoGlobalRepo.revogarTodasDaIdentidade(pool, d.identidade, 'SENHA_REDEFINIDA'), 0);
    assert.equal(await sessaoRepo.revogarTodasDaIdentidade(pool, d.identidade, 'SENHA_REDEFINIDA'), 0);
    const semSessao = await criarIdentidade(pool, `sem-sessao${etapa}@example.invalid`);
    assert.equal(await sessaoGlobalRepo.revogarTodasDaIdentidade(pool, semSessao, 'SENHA_REDEFINIDA'), 0);
    assert.equal(await sessaoRepo.revogarTodasDaIdentidade(pool, semSessao, 'SENHA_REDEFINIDA'), 0);
  });

  test('usa o executor recebido: revogação numa transação desfeita não persiste', async () => {
    const d = await cenario();
    const cliente = await pool.connect();
    try {
      await cliente.query('BEGIN');
      await sessaoGlobalRepo.revogarTodasDaIdentidade(cliente, d.identidade, 'SENHA_REDEFINIDA');
      await sessaoRepo.revogarTodasDaIdentidade(cliente, d.identidade, 'SENHA_REDEFINIDA');
      await cliente.query('ROLLBACK');
    } finally {
      cliente.release();
    }
    assert.deepEqual([await motivoGlobal(d.globalAtual), await motivoEmpresarial(d.empresarialAtualA)], [null, null]);
  });
});
