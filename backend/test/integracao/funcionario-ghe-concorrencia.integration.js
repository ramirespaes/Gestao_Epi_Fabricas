'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const funcionarioService = require('../../src/services/funcionario.service');
const gheService = require('../../src/services/grupo-homogeneo-exposicao.service');
const gheRepo = require('../../src/repositories/grupo-homogeneo-exposicao.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Concorrência entre VINCULAÇÃO de funcionário a um GHE e INATIVAÇÃO desse
 * GHE (Bloco 9, Etapa B — correção pós-auditoria de 23/09/2026), em
 * PostgreSQL real, com conexões independentes do mesmo Pool.
 *
 * O DEFEITO: funcionario.service verificava o GHE com uma leitura SEM lock
 * (gheRepo.buscarPorId). Entre essa leitura ("ativo") e o INSERT/UPDATE do
 * vínculo, outra transação podia inativar o GHE e COMMITAR; o vínculo era
 * então aceito a um GHE já inativo — a FK composta garante existência e
 * mesma empresa, nunca `ativo`.
 *
 * COMO O INTERLEAVING É CONTROLADO: os serviços REAIS rodam contra o banco
 * REAL; o único artifício de teste é um "portão" instalado com
 * t.mock.method na leitura do GHE que o serviço usa — o portão executa a
 * função ORIGINAL (a mesma consulta, o mesmo lock) e só então pausa o fluxo
 * até o teste liberá-lo. Assim o teste escolhe em que ponto cada transação
 * fica parada, mas nenhum comportamento é simulado. O portão é instalado
 * tanto em `buscarPorId` (leitura que o serviço usava antes da correção)
 * quanto em `buscarPorIdParaVinculo` (a leitura travada da correção): o
 * MESMO arquivo dá RED contra o código antigo e GREEN contra o corrigido.
 *
 * Cenários exigidos pela auditoria:
 *   A/D — vínculo (criar) chega primeiro, inativação espera; vínculo
 *         confirmado, inativação posterior PRESERVA o vínculo existente.
 *   B/C — inativação confirmada primeiro; vínculo por criar E por alterar
 *         (troca de GHE) são RECUSADOS (409), sem escrita e sem auditoria.
 *   F   — GHE diferente não é bloqueado.
 *   G   — outra empresa não é bloqueada; isolamento preservado.
 */

const MIGRATIONS = [
  '000', '001', '002', '003', '004', '005', '006', '007', '008', '009', '010', '011',
  '012', '013', '014', '015', '016', '017', '018', '019', '020', '021', '022', '023',
];

/** Espera até `condicao()` ser verdadeira (poll curto), ou falha. */
async function aguardar(condicao, mensagem, { tentativas = 300, intervaloMs = 10 } = {}) {
  for (let i = 0; i < tentativas; i += 1) {
    if (await condicao()) {
      return;
    }
    await new Promise((resolve) => { setTimeout(resolve, intervaloMs); });
  }
  throw new Error(`tempo esgotado: ${mensagem}`);
}

/** Quantos backends estão esperando lock numa consulta sobre grupos_homogeneos_exposicao. */
async function esperandoLockNoGhe(pool) {
  const { rows } = await pool.query(
    `SELECT count(*)::int AS n FROM pg_stat_activity
      WHERE wait_event_type = 'Lock' AND datname = current_database() AND query ILIKE '%grupos_homogeneos_exposicao%'`,
  );
  return rows[0].n;
}

/** Promise com flag de conclusão observável. */
function rastrear(promessa) {
  const estado = { concluida: false, valor: undefined, erro: undefined };
  estado.promessa = promessa.then(
    (v) => { estado.concluida = true; estado.valor = v; return v; },
    (e) => { estado.concluida = true; estado.erro = e; throw e; },
  );
  return estado;
}

/**
 * Instala um portão nas funções indicadas de gheRepo: executa a ORIGINAL e,
 * na primeira chamada que casar com `filtro`, sinaliza chegada e pausa até
 * liberar(). Chamadas seguintes passam direto.
 */
function instalarPortao(t, nomes, filtro = () => true) {
  let chegou;
  let liberar;
  const chegada = new Promise((resolve) => { chegou = resolve; });
  const liberacao = new Promise((resolve) => { liberar = resolve; });
  let disparado = false;
  // Qualquer saída do teste (inclusive uma asserção falhando ANTES de
  // liberar()) solta o portão: senão a transação parada seguraria uma
  // conexão do pool e o `after` (pool.end()) esperaria para sempre.
  t.after(() => liberar());
  for (const nome of nomes) {
    const original = gheRepo[nome];
    t.mock.method(gheRepo, nome, async function portao(...args) {
      const resultado = await original.apply(this, args);
      if (!disparado && filtro(...args)) {
        disparado = true;
        chegou();
        await liberacao;
      }
      return resultado;
    });
  }
  return { chegada, liberar };
}

const NOMES_LEITURA_VINCULO = ['buscarPorId', 'buscarPorIdParaVinculo'];

describe('concorrência vínculo × inativação de GHE (PostgreSQL real)', () => {
  let contexto;
  let pool;
  let empresaA;
  let empresaB;
  let masterA;
  let masterB;
  let contadorCpf = 0;
  let contadorMatricula = 0;

  const cpfValido = () => {
    // Gera CPFs válidos distintos a partir de uma base de 9 dígitos.
    contadorCpf += 1;
    const base = String(100000000 + contadorCpf).padStart(9, '0');
    const dv = (digitos, pesoInicial) => {
      let soma = 0;
      for (let i = 0; i < digitos.length; i += 1) soma += Number(digitos[i]) * (pesoInicial - i);
      const resto = soma % 11;
      return resto < 2 ? 0 : 11 - resto;
    };
    const d1 = dv(base, 10);
    const d2 = dv(base + d1, 11);
    return `${base}${d1}${d2}`;
  };
  const matricula = () => { contadorMatricula += 1; return `MAT-${String(contadorMatricula).padStart(6, '0')}`; };

  async function criarGhe(empresaId, atorId, nome) {
    return gheService.criar(pool, { empresaId, atorId, nome });
  }

  async function funcionarioNoBanco(id) {
    const { rows } = await pool.query('SELECT grupo_homogeneo_id FROM funcionarios WHERE id = $1', [id]);
    return rows[0] ?? null;
  }

  async function gheAtivo(id) {
    const { rows } = await pool.query('SELECT ativo FROM grupos_homogeneos_exposicao WHERE id = $1', [id]);
    return rows[0].ativo;
  }

  async function contarAuditoria(empresaId, acao) {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2', [empresaId, acao]);
    return rows[0].n;
  }

  async function contarFuncionarios(empresaId) {
    const { rows } = await pool.query('SELECT count(*)::int AS n FROM funcionarios WHERE empresa_id = $1', [empresaId]);
    return rows[0].n;
  }

  before(async () => {
    contexto = await abrirPoolTemporario(MIGRATIONS);
    pool = contexto.pool;
    assert.equal(await inserirEmpresa(pool, '11222333000181', 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(pool, '44555666000162', 'Empresa B'), 'ok');
    const { rows } = await pool.query('SELECT id FROM empresas ORDER BY id');
    [empresaA, empresaB] = rows.map((r) => r.id);
    const usuario = async (empresaId, email) => (await pool.query(
      "INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil) VALUES ($1, 'Master', $2, '$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', 'MASTER') RETURNING id",
      [empresaId, email],
    )).rows[0].id;
    masterA = await usuario(empresaA, 'a@demo.safeworkengenharia.com.br');
    masterB = await usuario(empresaB, 'b@demo.safeworkengenharia.com.br');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  test('Cenário A/D — criar chega primeiro: a inativação ESPERA o vínculo confirmar; depois inativa preservando o vínculo', async (t) => {
    const ghe = await criarGhe(empresaA, masterA, 'GHE A-D');
    const portao = instalarPortao(t, NOMES_LEITURA_VINCULO, (_c, _e, id) => id === ghe.id);

    const p1 = rastrear(funcionarioService.criar(pool, { empresaId: empresaA, atorId: masterA, matricula: matricula(), nome: 'F1', cpf: cpfValido(), grupoHomogeneoId: ghe.id }));
    await portao.chegada; // p1 leu o GHE (ativo) e está parado ANTES do INSERT

    const p2 = rastrear(gheService.inativar(pool, { empresaId: empresaA, atorId: masterA, gheId: ghe.id }));
    // Com a correção, p2 precisa ficar ESPERANDO o lock de p1. No código
    // antigo (leitura sem lock), p2 conclui aqui mesmo — e o vínculo abaixo
    // é aceito a um GHE já inativo.
    await aguardar(async () => p2.concluida || (await esperandoLockNoGhe(pool)) > 0, 'p2 esperando lock ou concluída');
    assert.equal(p2.concluida, false, 'DEFEITO: a inativação foi confirmada enquanto a vinculação ainda estava em curso (leitura do GHE sem lock)');

    portao.liberar();
    const funcionario = await p1.promessa;
    const inativacao = await p2.promessa;

    assert.equal(funcionario.grupoHomogeneoId, ghe.id);
    assert.equal(inativacao.alterado, true);
    assert.equal(await gheAtivo(ghe.id), false);
    assert.equal((await funcionarioNoBanco(funcionario.id)).grupo_homogeneo_id, ghe.id, 'D: vínculo confirmado antes é preservado pela inativação posterior');
  });

  test('Cenário C — inativação confirmada primeiro: criar com vínculo é RECUSADO (409), sem escrita e sem auditoria', async (t) => {
    const ghe = await criarGhe(empresaA, masterA, 'GHE C');
    const portao = instalarPortao(t, ['buscarPorIdParaAtualizacao'], (_c, _e, id) => id === ghe.id);
    const funcionariosAntes = await contarFuncionarios(empresaA);
    const criadosAntes = await contarAuditoria(empresaA, 'FUNCIONARIO_CRIADO');

    const p2 = rastrear(gheService.inativar(pool, { empresaId: empresaA, atorId: masterA, gheId: ghe.id }));
    await portao.chegada; // p2 tem FOR UPDATE no GHE e está parado antes do UPDATE

    const p1 = rastrear(funcionarioService.criar(pool, { empresaId: empresaA, atorId: masterA, matricula: matricula(), nome: 'F2', cpf: cpfValido(), grupoHomogeneoId: ghe.id }));
    await aguardar(async () => p1.concluida || (await esperandoLockNoGhe(pool)) > 0, 'p1 esperando lock ou concluída');
    assert.equal(p1.concluida, false, 'DEFEITO: a vinculação não esperou a inativação em curso (leitura do GHE sem lock)');

    portao.liberar();
    await p2.promessa;
    await assert.rejects(p1.promessa, (e) => HttpError.ehHttpError(e) && e.status === 409 && e.codigo === 'FUNCIONARIO_GHE_INATIVO');

    assert.equal(await contarFuncionarios(empresaA), funcionariosAntes, 'E: nenhuma escrita parcial');
    assert.equal(await contarAuditoria(empresaA, 'FUNCIONARIO_CRIADO'), criadosAntes, 'E: nenhuma auditoria indevida');
  });

  test('Cenário B/C — inativação confirmada primeiro: ALTERAR para esse GHE é RECUSADO; o funcionário permanece como estava', async (t) => {
    const gheOrigem = await criarGhe(empresaA, masterA, 'GHE B origem');
    const gheDestino = await criarGhe(empresaA, masterA, 'GHE B destino');
    const funcionario = await funcionarioService.criar(pool, { empresaId: empresaA, atorId: masterA, matricula: matricula(), nome: 'F3', cpf: cpfValido(), grupoHomogeneoId: gheOrigem.id });
    const alteradosAntes = await contarAuditoria(empresaA, 'FUNCIONARIO_ALTERADO');

    const portao = instalarPortao(t, ['buscarPorIdParaAtualizacao'], (_c, _e, id) => id === gheDestino.id);
    const p2 = rastrear(gheService.inativar(pool, { empresaId: empresaA, atorId: masterA, gheId: gheDestino.id }));
    await portao.chegada;

    const p1 = rastrear(funcionarioService.alterar(pool, { empresaId: empresaA, atorId: masterA, funcionarioId: funcionario.id, grupoHomogeneoId: gheDestino.id, grupoHomogeneoIdInformado: true }));
    await aguardar(async () => p1.concluida || (await esperandoLockNoGhe(pool)) > 0, 'p1 esperando lock ou concluída');
    assert.equal(p1.concluida, false, 'DEFEITO: a troca de GHE não esperou a inativação em curso');

    portao.liberar();
    await p2.promessa;
    await assert.rejects(p1.promessa, (e) => HttpError.ehHttpError(e) && e.status === 409 && e.codigo === 'FUNCIONARIO_GHE_INATIVO');
    assert.equal((await funcionarioNoBanco(funcionario.id)).grupo_homogeneo_id, gheOrigem.id, 'vínculo original intacto');
    assert.equal(await contarAuditoria(empresaA, 'FUNCIONARIO_ALTERADO'), alteradosAntes);
  });

  test('Cenário A/D por ALTERAR — troca confirmada primeiro é preservada pela inativação posterior', async (t) => {
    const gheOrigem = await criarGhe(empresaA, masterA, 'GHE AD-alt origem');
    const gheDestino = await criarGhe(empresaA, masterA, 'GHE AD-alt destino');
    const funcionario = await funcionarioService.criar(pool, { empresaId: empresaA, atorId: masterA, matricula: matricula(), nome: 'F4', cpf: cpfValido(), grupoHomogeneoId: gheOrigem.id });
    const portao = instalarPortao(t, NOMES_LEITURA_VINCULO, (_c, _e, id) => id === gheDestino.id);

    const p1 = rastrear(funcionarioService.alterar(pool, { empresaId: empresaA, atorId: masterA, funcionarioId: funcionario.id, grupoHomogeneoId: gheDestino.id, grupoHomogeneoIdInformado: true }));
    await portao.chegada;
    const p2 = rastrear(gheService.inativar(pool, { empresaId: empresaA, atorId: masterA, gheId: gheDestino.id }));
    await aguardar(async () => p2.concluida || (await esperandoLockNoGhe(pool)) > 0, 'p2 esperando lock ou concluída');
    assert.equal(p2.concluida, false, 'DEFEITO: inativação confirmada durante a troca de GHE');

    portao.liberar();
    const alterado = await p1.promessa;
    await p2.promessa;
    assert.equal(alterado.grupoHomogeneoId, gheDestino.id);
    assert.equal(await gheAtivo(gheDestino.id), false);
    assert.equal((await funcionarioNoBanco(funcionario.id)).grupo_homogeneo_id, gheDestino.id, 'D: vínculo preservado');
  });

  test('Cenário F — inativação em curso do GHE X não bloqueia vínculo ao GHE Y da mesma empresa', async (t) => {
    const gheX = await criarGhe(empresaA, masterA, 'GHE F X');
    const gheY = await criarGhe(empresaA, masterA, 'GHE F Y');
    const portao = instalarPortao(t, ['buscarPorIdParaAtualizacao'], (_c, _e, id) => id === gheX.id);

    const p2 = rastrear(gheService.inativar(pool, { empresaId: empresaA, atorId: masterA, gheId: gheX.id }));
    await portao.chegada; // FOR UPDATE em X, parado

    const outro = rastrear(funcionarioService.criar(pool, { empresaId: empresaA, atorId: masterA, matricula: matricula(), nome: 'F5', cpf: cpfValido(), grupoHomogeneoId: gheY.id }));
    await aguardar(async () => outro.concluida, 'vínculo ao GHE Y concluído enquanto X está travado', { tentativas: 200 });
    assert.equal(outro.erro, undefined);
    assert.equal(outro.valor.grupoHomogeneoId, gheY.id);

    portao.liberar();
    await p2.promessa;
  });

  test('Cenário G — inativação em curso na empresa A não bloqueia a empresa B; isolamento preservado', async (t) => {
    const gheA = await criarGhe(empresaA, masterA, 'GHE G A');
    const gheB = await criarGhe(empresaB, masterB, 'GHE G B');
    const portao = instalarPortao(t, ['buscarPorIdParaAtualizacao'], (_c, _e, id) => id === gheA.id);

    const p2 = rastrear(gheService.inativar(pool, { empresaId: empresaA, atorId: masterA, gheId: gheA.id }));
    await portao.chegada;

    const emB = rastrear(funcionarioService.criar(pool, { empresaId: empresaB, atorId: masterB, matricula: matricula(), nome: 'F6', cpf: cpfValido(), grupoHomogeneoId: gheB.id }));
    await aguardar(async () => emB.concluida, 'empresa B concluída enquanto A está travada', { tentativas: 200 });
    assert.equal(emB.erro, undefined);

    // Isolamento: B não consegue vincular ao GHE de A mesmo com A travada (400, nunca espera lock).
    await assert.rejects(
      funcionarioService.criar(pool, { empresaId: empresaB, atorId: masterB, matricula: matricula(), nome: 'F7', cpf: cpfValido(), grupoHomogeneoId: gheA.id }),
      (e) => HttpError.ehHttpError(e) && e.status === 400 && e.codigo === 'FUNCIONARIO_GHE_INVALIDO',
    );

    portao.liberar();
    await p2.promessa;
  });
});
