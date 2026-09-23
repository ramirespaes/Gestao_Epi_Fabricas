'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const servico = require('../../src/services/autorizacao-individual.service');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const permissoes = require('../../src/repositories/permissao.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Serviço de concessão/revogação de autorizações individuais contra
 * PostgreSQL real (Bloco 8, Incremento 8, Etapa 5A, Subetapa 3I): as
 * transações, os FOR UPDATE, a FK composta de origem e os índices únicos
 * parciais da migration 023, a cascata de descendentes, a trilha em
 * logs_auditoria (com as triggers das migrations 012/014 ativas) — tudo de
 * verdade, num schema temporário exclusivo removido em cascata ao final.
 * O schema public não é lido nem escrito.
 *
 * Um único Pool temporário injetado no serviço (que faz pool.connect()),
 * nunca o pool global. Cada cenário usa e-mails/nomes exclusivos, para não
 * depender de ordem entre testes.
 */

const ACAO_ALTERNATIVA = 'MOVIMENTAR_ESTOQUE';   // 017: ALTERNATIVA, sem SST
const ACAO_OBRIGATORIA = 'APROVAR_SOLICITACAO';  // 017: OBRIGATORIA, exige_sst
const ACAO_NENHUMA = 'GERENCIAR_USUARIOS';       // 017: padrão NENHUMA
// ALTERNATIVA (017), como MOVIMENTAR_ESTOQUE: os cenários abaixo precisam
// de uma ação concedível para só então desativá-la / corromper seu modo.
const ACAO_PARA_DESATIVAR = 'REALIZAR_ENTREGA';

const MIGRATIONS = ['000', '001', '002', '003', '005', '010', '011', '012', '013', '014', '016', '017', '018', '019', '020', '021', '023'];

const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28';

async function inserirUsuario(pool, empresaId, email, perfil = 'SUPERVISOR', ativo = true) {
  const { rows } = await pool.query(
    'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [empresaId, `Usuário ${email}`, email, HASH, perfil, ativo],
  );
  return rows[0].id;
}

async function lerAutorizacao(pool, id) {
  const { rows } = await pool.query('SELECT * FROM usuario_autorizacoes WHERE id = $1', [id]);
  return rows[0] ?? null;
}

async function lerAuditoria(pool, empresaId, acao, referencia) {
  const { rows } = await pool.query(
    'SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2 AND referencia = $3 ORDER BY id',
    [empresaId, acao, referencia],
  );
  return rows;
}

async function contarAutorizacoes(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM usuario_autorizacoes WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

async function contarAuditoria(pool, empresaId) {
  const { rows } = await pool.query('SELECT count(*)::int AS total FROM logs_auditoria WHERE empresa_id = $1', [empresaId]);
  return rows[0].total;
}

async function esperarHttpError(promessa, status, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.ok(HttpError.ehHttpError(erro), `esperado HttpError ${status} ${codigo}, veio ${erro && erro.name}: ${erro && erro.message}`);
    assert.equal(erro.status, status);
    assert.equal(erro.codigo, codigo);
    return true;
  });
}

describe('serviço de autorizações individuais em PostgreSQL real', () => {
  let contexto;
  let pool;
  let empresaA;
  let empresaB;
  let masterA;
  let masterB;

  before(async () => {
    contexto = await abrirPoolTemporario(MIGRATIONS);
    pool = contexto.pool;
    assert.equal(await inserirEmpresa(pool, '12345678000195', 'Empresa A'), 'ok');
    assert.equal(await inserirEmpresa(pool, '98765432000110', 'Empresa B'), 'ok');
    const { rows } = await pool.query('SELECT id, cnpj FROM empresas ORDER BY id');
    empresaA = rows.find((e) => e.cnpj === '12345678000195').id;
    empresaB = rows.find((e) => e.cnpj === '98765432000110').id;
    masterA = await inserirUsuario(pool, empresaA, 'master-a@demo.safeworkengenharia.com.br', 'MASTER');
    masterB = await inserirUsuario(pool, empresaB, 'master-b@demo.safeworkengenharia.com.br', 'MASTER');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  describe('concessão direta pelo MASTER', () => {
    test('persiste com origem_id NULL, pode_delegar false por padrão, autorizado_por = MASTER, e grava auditoria na mesma transação', async () => {
      const carlos = await inserirUsuario(pool, empresaA, 'carlos-direta@demo.safeworkengenharia.com.br');

      const criada = await servico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterA, usuarioId: carlos, acaoCodigo: ACAO_ALTERNATIVA, motivo: 'almoxarifado',
      });

      const linha = await lerAutorizacao(pool, criada.id);
      assert.equal(linha.empresa_id, empresaA);
      assert.equal(linha.usuario_id, carlos);
      assert.equal(linha.acao_codigo, ACAO_ALTERNATIVA);
      assert.equal(linha.autorizado_por, masterA);
      assert.equal(linha.pode_delegar, false);
      assert.equal(linha.origem_id, null);
      assert.equal(linha.motivo, 'almoxarifado');

      const [auditoria] = await lerAuditoria(pool, empresaA, 'AUTORIZACAO_INDIVIDUAL_CONCEDIDA', String(criada.id));
      assert.ok(auditoria, 'a concessão precisa ter registro em logs_auditoria');
      assert.equal(auditoria.usuario_id, masterA);
      assert.deepEqual(auditoria.contexto, { tipo: 'DIRETA' });
      assert.deepEqual(auditoria.dados_novos, { usuarioId: carlos, acaoCodigo: ACAO_ALTERNATIVA, autorizadoPor: masterA, podeDelegar: false, origemId: null });
      assert.equal(auditoria.dados_anteriores, null);

      // O que o middleware lê passa a ser verdadeiro, sem nenhuma alteração nele.
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, carlos, ACAO_ALTERNATIVA), true);
    });

    test('pode_delegar=true expresso pelo MASTER é persistido', async () => {
      const chefe = await inserirUsuario(pool, empresaA, 'chefe-direta@demo.safeworkengenharia.com.br');

      const criada = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: chefe, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });

      assert.equal((await lerAutorizacao(pool, criada.id)).pode_delegar, true);
    });

    test('não-MASTER não concede diretamente: 403, nada gravado', async () => {
      const supervisor = await inserirUsuario(pool, empresaA, 'supervisor-tenta-direta@demo.safeworkengenharia.com.br');
      const alvo = await inserirUsuario(pool, empresaA, 'alvo-direta-negada@demo.safeworkengenharia.com.br');
      const antes = await contarAutorizacoes(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      await esperarHttpError(servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: supervisor, usuarioId: alvo, acaoCodigo: ACAO_ALTERNATIVA }), 403, 'CONCESSAO_NAO_AUTORIZADA');

      assert.equal(await contarAutorizacoes(pool, empresaA), antes);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'recusa não é auditada');
    });

    test('autoconcessão: 400', async () => {
      await esperarHttpError(servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: masterA, acaoCodigo: ACAO_ALTERNATIVA }), 400, 'AUTOCONCESSAO_NAO_PERMITIDA');
    });

    test('beneficiário inativo: 400, nada gravado', async () => {
      const inativo = await inserirUsuario(pool, empresaA, 'inativo-direta@demo.safeworkengenharia.com.br', 'USUARIO', false);
      const antes = await contarAutorizacoes(pool, empresaA);

      await esperarHttpError(servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: inativo, acaoCodigo: ACAO_ALTERNATIVA }), 400, 'CONCESSAO_INVALIDA');

      assert.equal(await contarAutorizacoes(pool, empresaA), antes);
    });

    test('beneficiário de outra empresa: 400 — o MASTER de A não concede a usuário de B', async () => {
      const deB = await inserirUsuario(pool, empresaB, 'alvo-de-b@demo.safeworkengenharia.com.br');

      await esperarHttpError(servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: deB, acaoCodigo: ACAO_ALTERNATIVA }), 400, 'CONCESSAO_INVALIDA');
      await esperarHttpError(servico.concederDireta(pool, { empresaId: empresaB, concedidoPor: masterA, usuarioId: deB, acaoCodigo: ACAO_ALTERNATIVA }), 403, 'CONCESSAO_NAO_AUTORIZADA');
    });

    test('ação inexistente no catálogo, e ação desativada: 400', async () => {
      const alvo = await inserirUsuario(pool, empresaA, 'alvo-acao-invalida@demo.safeworkengenharia.com.br');

      await esperarHttpError(servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: alvo, acaoCodigo: 'ACAO_QUE_NAO_EXISTE' }), 400, 'CONCESSAO_INVALIDA');

      await pool.query('UPDATE acoes SET ativo = false WHERE codigo = $1', [ACAO_PARA_DESATIVAR]);
      try {
        await esperarHttpError(servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: alvo, acaoCodigo: ACAO_PARA_DESATIVAR }), 400, 'CONCESSAO_INVALIDA');
      } finally {
        await pool.query('UPDATE acoes SET ativo = true WHERE codigo = $1', [ACAO_PARA_DESATIVAR]);
      }
    });

    test('duplicidade de autorização direta (índice único parcial da 023): 409, e a primeira permanece', async () => {
      const alvo = await inserirUsuario(pool, empresaA, 'alvo-duplicada@demo.safeworkengenharia.com.br');
      const primeira = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: alvo, acaoCodigo: ACAO_ALTERNATIVA });

      await esperarHttpError(servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: alvo, acaoCodigo: ACAO_ALTERNATIVA }), 409, 'AUTORIZACAO_JA_EXISTE');

      assert.ok(await lerAutorizacao(pool, primeira.id));
    });
  });

  describe('delegação', () => {
    test('delegação válida: ação da origem, autorizado_por = delegador, origem_id preenchido, auditoria com tipo DELEGADA', async () => {
      const carlos = await inserirUsuario(pool, empresaA, 'carlos-delegador@demo.safeworkengenharia.com.br');
      const joana = await inserirUsuario(pool, empresaA, 'joana-delegada@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: carlos, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });

      const delegada = await servico.delegar(pool, { empresaId: empresaA, concedidoPor: carlos, origemId: origem.id, usuarioId: joana });

      const linha = await lerAutorizacao(pool, delegada.id);
      assert.equal(linha.usuario_id, joana);
      assert.equal(linha.acao_codigo, ACAO_ALTERNATIVA, 'a ação é a da origem');
      assert.equal(linha.autorizado_por, carlos);
      assert.equal(linha.origem_id, origem.id);
      assert.equal(linha.pode_delegar, false);

      const [auditoria] = await lerAuditoria(pool, empresaA, 'AUTORIZACAO_INDIVIDUAL_CONCEDIDA', String(delegada.id));
      assert.equal(auditoria.usuario_id, carlos);
      assert.deepEqual(auditoria.contexto, { tipo: 'DELEGADA', origemId: origem.id });

      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, joana, ACAO_ALTERNATIVA), true);
    });

    test('MASTER não delega: mesmo com origem própria e pode_delegar=true, o caminho dele é concederDireta — 403, nada gravado', async () => {
      const alvo = await inserirUsuario(pool, empresaA, 'alvo-master-nao-delega@demo.safeworkengenharia.com.br', 'USUARIO');
      const origemDoMaster = await servico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: masterB === masterA ? masterB : masterA, usuarioId: alvo, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });
      // Agora o MASTER recebe uma autorização própria, concedida por outro
      // MASTER da mesma empresa, para ter uma origem legítima em mãos.
      const outroMaster = await inserirUsuario(pool, empresaA, 'outro-master@demo.safeworkengenharia.com.br', 'MASTER');
      const origemDele = await servico.concederDireta(pool, {
        empresaId: empresaA, concedidoPor: outroMaster, usuarioId: masterA, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true,
      });
      const antes = await contarAutorizacoes(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: masterA, origemId: origemDele.id, usuarioId: alvo }), 403, 'DELEGACAO_NAO_AUTORIZADA');

      assert.equal(await contarAutorizacoes(pool, empresaA), antes, 'nada foi criado');
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'recusa não é auditada');
      assert.ok(await lerAutorizacao(pool, origemDele.id), 'a origem do MASTER permanece intacta');
      assert.ok(await lerAutorizacao(pool, origemDoMaster.id));
    });

    test('pode_delegar=false na origem: executar não é delegar — 403, nada gravado', async () => {
      const carlos = await inserirUsuario(pool, empresaA, 'carlos-sem-delegar@demo.safeworkengenharia.com.br');
      const joana = await inserirUsuario(pool, empresaA, 'joana-sem-delegar@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: carlos, acaoCodigo: ACAO_ALTERNATIVA });
      const antes = await contarAutorizacoes(pool, empresaA);

      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: carlos, origemId: origem.id, usuarioId: joana }), 403, 'DELEGACAO_NAO_AUTORIZADA');

      assert.equal(await contarAutorizacoes(pool, empresaA), antes);
    });

    test('grupo de acesso não fornece direito de delegar: membro de grupo que concede a ação, sem linha própria, não delega', async () => {
      const membro = await inserirUsuario(pool, empresaA, 'membro-grupo@demo.safeworkengenharia.com.br');
      const joana = await inserirUsuario(pool, empresaA, 'joana-grupo@demo.safeworkengenharia.com.br', 'USUARIO');
      const outro = await inserirUsuario(pool, empresaA, 'outro-com-origem@demo.safeworkengenharia.com.br');
      const { rows: [{ id: grupoId }] } = await pool.query(
        'INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id',
        [empresaA, 'Grupo Almoxarifado', masterA],
      );
      await pool.query('INSERT INTO grupo_permissoes_acao (empresa_id, grupo_acesso_id, acao_codigo, permitido) VALUES ($1, $2, $3, true)', [empresaA, grupoId, ACAO_ALTERNATIVA]);
      await pool.query('UPDATE usuarios SET grupo_acesso_id = $1 WHERE id = $2', [grupoId, membro]);
      // Existe uma origem válida na empresa — mas de OUTRA pessoa.
      const origemAlheia = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: outro, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });
      const antes = await contarAutorizacoes(pool, empresaA);

      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: membro, origemId: origemAlheia.id, usuarioId: joana }), 403, 'DELEGACAO_NAO_AUTORIZADA');

      assert.equal(await contarAutorizacoes(pool, empresaA), antes);
    });

    test('delegador que perdeu a autorização efetiva (linha própria removida por fora): 403, nada gravado', async () => {
      const ana = await inserirUsuario(pool, empresaA, 'ana-sem-efetiva@demo.safeworkengenharia.com.br', 'SUPERVISOR');
      const bia = await inserirUsuario(pool, empresaA, 'bia-sem-efetiva@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: ana, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });
      // Delegação válida enquanto a linha própria existe.
      assert.ok(await servico.delegar(pool, { empresaId: empresaA, concedidoPor: ana, origemId: origem.id, usuarioId: bia }));

      const carlos = await inserirUsuario(pool, empresaA, 'carlos-sem-efetiva@demo.safeworkengenharia.com.br', 'USUARIO');
      await pool.query('DELETE FROM usuario_autorizacoes WHERE id = $1', [origem.id]);
      const antes = await contarAutorizacoes(pool, empresaA);

      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: ana, origemId: origem.id, usuarioId: carlos }), 403, 'DELEGACAO_NAO_AUTORIZADA');

      assert.equal(await contarAutorizacoes(pool, empresaA), antes);
    });

    test('exige_sst: delegador fora da SST não delega APROVAR_SOLICITACAO; com vinculo_sst real, delega', async () => {
      const maria = await inserirUsuario(pool, empresaA, 'maria-sst@demo.safeworkengenharia.com.br');
      const pedro = await inserirUsuario(pool, empresaA, 'pedro-sst@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: maria, acaoCodigo: ACAO_OBRIGATORIA, podeDelegar: true });

      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: maria, origemId: origem.id, usuarioId: pedro }), 403, 'DELEGACAO_NAO_AUTORIZADA');

      await pool.query('INSERT INTO vinculo_sst (usuario_id, empresa_id, concedido_por) VALUES ($1, $2, $3)', [maria, empresaA, masterA]);
      const delegada = await servico.delegar(pool, { empresaId: empresaA, concedidoPor: maria, origemId: origem.id, usuarioId: pedro });
      assert.equal((await lerAutorizacao(pool, delegada.id)).acao_codigo, ACAO_OBRIGATORIA);
    });

    test('bloqueio individual do delegador prevalece: 403; removido o bloqueio, delega', async () => {
      const lucas = await inserirUsuario(pool, empresaA, 'lucas-bloqueado@demo.safeworkengenharia.com.br');
      const nina = await inserirUsuario(pool, empresaA, 'nina-bloqueio@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: lucas, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });
      await pool.query('INSERT INTO usuario_bloqueios (usuario_id, acao_codigo) VALUES ($1, $2)', [lucas, ACAO_ALTERNATIVA]);

      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: lucas, origemId: origem.id, usuarioId: nina }), 403, 'DELEGACAO_NAO_AUTORIZADA');

      await pool.query('DELETE FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo = $2', [lucas, ACAO_ALTERNATIVA]);
      assert.ok(await servico.delegar(pool, { empresaId: empresaA, concedidoPor: lucas, origemId: origem.id, usuarioId: nina }));
    });

    test('tentativa entre empresas: origem e delegador de B não delegam em A; e a origem de B não serve em A nem para um delegador de A', async () => {
      const delegadorB = await inserirUsuario(pool, empresaB, 'delegador-b@demo.safeworkengenharia.com.br');
      const alvoB = await inserirUsuario(pool, empresaB, 'alvo-b@demo.safeworkengenharia.com.br', 'USUARIO');
      const delegadorA = await inserirUsuario(pool, empresaA, 'delegador-a-cruzado@demo.safeworkengenharia.com.br');
      const alvoA = await inserirUsuario(pool, empresaA, 'alvo-a-cruzado@demo.safeworkengenharia.com.br', 'USUARIO');
      const origemB = await servico.concederDireta(pool, { empresaId: empresaB, concedidoPor: masterB, usuarioId: delegadorB, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });
      const antesA = await contarAutorizacoes(pool, empresaA);

      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: delegadorB, origemId: origemB.id, usuarioId: alvoA }), 403, 'DELEGACAO_NAO_AUTORIZADA');
      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: delegadorA, origemId: origemB.id, usuarioId: alvoA }), 403, 'DELEGACAO_NAO_AUTORIZADA');
      await esperarHttpError(servico.delegar(pool, { empresaId: empresaB, concedidoPor: delegadorB, origemId: origemB.id, usuarioId: alvoA }), 403, 'DELEGACAO_NAO_AUTORIZADA');

      assert.equal(await contarAutorizacoes(pool, empresaA), antesA);
      // Dentro de B, com beneficiário de B, funciona.
      assert.ok(await servico.delegar(pool, { empresaId: empresaB, concedidoPor: delegadorB, origemId: origemB.id, usuarioId: alvoB }));
    });

    test('autoconcessão, beneficiário inativo e ação desativada depois da concessão da origem', async () => {
      const carlos = await inserirUsuario(pool, empresaA, 'carlos-varios@demo.safeworkengenharia.com.br');
      const inativa = await inserirUsuario(pool, empresaA, 'inativa-varios@demo.safeworkengenharia.com.br', 'USUARIO', false);
      const viva = await inserirUsuario(pool, empresaA, 'viva-varios@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: carlos, acaoCodigo: ACAO_PARA_DESATIVAR, podeDelegar: true });

      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: carlos, origemId: origem.id, usuarioId: carlos }), 400, 'AUTOCONCESSAO_NAO_PERMITIDA');
      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: carlos, origemId: origem.id, usuarioId: inativa }), 403, 'DELEGACAO_NAO_AUTORIZADA');

      await pool.query('UPDATE acoes SET ativo = false WHERE codigo = $1', [ACAO_PARA_DESATIVAR]);
      try {
        await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: carlos, origemId: origem.id, usuarioId: viva }), 403, 'DELEGACAO_NAO_AUTORIZADA');
      } finally {
        await pool.query('UPDATE acoes SET ativo = true WHERE codigo = $1', [ACAO_PARA_DESATIVAR]);
      }
    });

    test('mesma origem delegando duas vezes ao mesmo usuário: 409; origens distintas coexistem', async () => {
      const d1 = await inserirUsuario(pool, empresaA, 'd1-coexiste@demo.safeworkengenharia.com.br');
      const d2 = await inserirUsuario(pool, empresaA, 'd2-coexiste@demo.safeworkengenharia.com.br');
      const alvo = await inserirUsuario(pool, empresaA, 'alvo-coexiste@demo.safeworkengenharia.com.br', 'USUARIO');
      const o1 = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: d1, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });
      const o2 = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: d2, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });

      await servico.delegar(pool, { empresaId: empresaA, concedidoPor: d1, origemId: o1.id, usuarioId: alvo });
      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: d1, origemId: o1.id, usuarioId: alvo }), 409, 'AUTORIZACAO_JA_EXISTE');
      await servico.delegar(pool, { empresaId: empresaA, concedidoPor: d2, origemId: o2.id, usuarioId: alvo });

      const { rows } = await pool.query('SELECT origem_id FROM usuario_autorizacoes WHERE usuario_id = $1 AND acao_codigo = $2 ORDER BY origem_id', [alvo, ACAO_ALTERNATIVA]);
      assert.deepEqual(rows.map((r) => r.origem_id), [o1.id, o2.id].sort((a, b) => a - b));
    });
  });

  describe('modo NENHUMA e configuração inválida da ação', () => {
    test('ação em modo NENHUMA (catálogo real): concessão direta recusada com 400, sem gravar nada', async () => {
      const alvo = await inserirUsuario(pool, empresaA, 'alvo-nenhuma@demo.safeworkengenharia.com.br', 'USUARIO');
      const { rows: [modo] } = await pool.query('SELECT modo_autorizacao_individual FROM acoes WHERE codigo = $1', [ACAO_NENHUMA]);
      assert.equal(modo.modo_autorizacao_individual, 'NENHUMA', 'o cenário depende do valor real do catálogo');
      const antes = await contarAutorizacoes(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      await esperarHttpError(servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: alvo, acaoCodigo: ACAO_NENHUMA }), 400, 'CONCESSAO_INVALIDA');

      assert.equal(await contarAutorizacoes(pool, empresaA), antes);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, alvo, ACAO_NENHUMA), false);
    });

    test('linha preexistente de ação em modo NENHUMA não é apagada, mas tampouco serve de origem para delegar', async () => {
      const veterano = await inserirUsuario(pool, empresaA, 'veterano-nenhuma@demo.safeworkengenharia.com.br', 'SUPERVISOR');
      const novato = await inserirUsuario(pool, empresaA, 'novato-nenhuma@demo.safeworkengenharia.com.br', 'USUARIO');
      // Linha histórica, criada antes desta regra (INSERT direto, como
      // estaria num banco já em produção).
      const { rows: [preexistente] } = await pool.query(
        `INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por, pode_delegar)
         VALUES ($1, $2, $3, $4, true) RETURNING id`,
        [empresaA, veterano, ACAO_NENHUMA, masterA],
      );

      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: veterano, origemId: preexistente.id, usuarioId: novato }), 403, 'DELEGACAO_NAO_AUTORIZADA');

      assert.ok(await lerAutorizacao(pool, preexistente.id), 'o serviço não apaga dados preexistentes');
    });

    test('configuração irreconhecível com a ação ATIVA: concessão e delegação recusadas, sem gravação parcial', async () => {
      const dono = await inserirUsuario(pool, empresaA, 'dono-config-invalida@demo.safeworkengenharia.com.br', 'SUPERVISOR');
      const alvo = await inserirUsuario(pool, empresaA, 'alvo-config-invalida@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: dono, acaoCodigo: ACAO_PARA_DESATIVAR, podeDelegar: true });
      const antes = await contarAutorizacoes(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      // O CHECK da migration 017 impede gravar um modo inválido; a
      // simulação usa o catálogo real por outro caminho: remover a ação do
      // catálogo não serve (FK), então o modo é trocado para NENHUMA — o
      // outro caso que carregarAcaoConcedivel recusa — e a cobertura de
      // modo/exige_sst realmente irreconhecíveis fica no teste unitário,
      // onde o repositório pode devolver o valor corrompido.
      await pool.query('UPDATE acoes SET modo_autorizacao_individual = $1 WHERE codigo = $2', ['NENHUMA', ACAO_PARA_DESATIVAR]);
      try {
        const { rows: [config] } = await pool.query('SELECT ativo FROM acoes WHERE codigo = $1', [ACAO_PARA_DESATIVAR]);
        assert.equal(config.ativo, true, 'a ação precisa continuar ATIVA para o teste ter valor');

        await esperarHttpError(servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: alvo, acaoCodigo: ACAO_PARA_DESATIVAR }), 400, 'CONCESSAO_INVALIDA');
        await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: dono, origemId: origem.id, usuarioId: alvo }), 403, 'DELEGACAO_NAO_AUTORIZADA');

        assert.equal(await contarAutorizacoes(pool, empresaA), antes);
        assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
      } finally {
        await pool.query('UPDATE acoes SET modo_autorizacao_individual = $1 WHERE codigo = $2', ['ALTERNATIVA', ACAO_PARA_DESATIVAR]);
      }
    });
  });

  describe('revogação', () => {
    test('MASTER revoga a origem: cascata da FK remove filho e neto; auditoria registra total e ids; autorização independente permanece', async () => {
      const raiz = await inserirUsuario(pool, empresaA, 'raiz-rev@demo.safeworkengenharia.com.br');
      const filho = await inserirUsuario(pool, empresaA, 'filho-rev@demo.safeworkengenharia.com.br');
      const neto = await inserirUsuario(pool, empresaA, 'neto-rev@demo.safeworkengenharia.com.br', 'USUARIO');
      const independente = await inserirUsuario(pool, empresaA, 'independente-rev@demo.safeworkengenharia.com.br');

      const oRaiz = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: raiz, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });
      const oFilho = await servico.delegar(pool, { empresaId: empresaA, concedidoPor: raiz, origemId: oRaiz.id, usuarioId: filho, podeDelegar: true });
      const oNeto = await servico.delegar(pool, { empresaId: empresaA, concedidoPor: filho, origemId: oFilho.id, usuarioId: neto });
      const oIndependente = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: independente, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });
      // O neto também recebe, da origem independente, a mesma ação: essa linha deve sobreviver.
      const oNetoIndependente = await servico.delegar(pool, { empresaId: empresaA, concedidoPor: independente, origemId: oIndependente.id, usuarioId: neto });

      const resultado = await servico.revogar(pool, { empresaId: empresaA, revogadoPor: masterA, autorizacaoId: oRaiz.id, motivo: 'saída do setor' });

      assert.equal(resultado.descendentesObservados, 2);
      assert.equal(await lerAutorizacao(pool, oRaiz.id), null);
      assert.equal(await lerAutorizacao(pool, oFilho.id), null, 'filho cai em cascata');
      assert.equal(await lerAutorizacao(pool, oNeto.id), null, 'neto cai em cascata, transitivamente');
      assert.ok(await lerAutorizacao(pool, oIndependente.id), 'origem independente permanece');
      assert.ok(await lerAutorizacao(pool, oNetoIndependente.id), 'a linha do neto vinda da origem independente permanece');
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, neto, ACAO_ALTERNATIVA), true, 'o neto continua autorizado pela origem independente');
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, filho, ACAO_ALTERNATIVA), false);

      const [auditoria] = await lerAuditoria(pool, empresaA, 'AUTORIZACAO_INDIVIDUAL_REVOGADA', String(oRaiz.id));
      assert.equal(auditoria.usuario_id, masterA);
      assert.equal(auditoria.descricao, 'saída do setor');
      assert.deepEqual(auditoria.contexto, { descendentesObservados: { total: 2, ids: [oFilho.id, oNeto.id], amostraLimitadaA: 50 } });
      assert.deepEqual(auditoria.dados_anteriores, { usuarioId: raiz, acaoCodigo: ACAO_ALTERNATIVA, autorizadoPor: masterA, podeDelegar: true, origemId: null });
    });

    test('revogar uma delegação intermediária não toca a origem acima dela', async () => {
      const raiz = await inserirUsuario(pool, empresaA, 'raiz-meio@demo.safeworkengenharia.com.br');
      const filho = await inserirUsuario(pool, empresaA, 'filho-meio@demo.safeworkengenharia.com.br', 'USUARIO');
      const oRaiz = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: raiz, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });
      const oFilho = await servico.delegar(pool, { empresaId: empresaA, concedidoPor: raiz, origemId: oRaiz.id, usuarioId: filho });

      const resultado = await servico.revogar(pool, { empresaId: empresaA, revogadoPor: raiz, autorizacaoId: oFilho.id });

      assert.equal(resultado.descendentesObservados, 0);
      assert.equal(await lerAutorizacao(pool, oFilho.id), null);
      assert.ok(await lerAutorizacao(pool, oRaiz.id), 'a origem do delegador continua intacta');
    });

    test('concedente não-MASTER revoga só o que ele mesmo concedeu; outro não-MASTER recebe 403 e nada muda', async () => {
      const carlos = await inserirUsuario(pool, empresaA, 'carlos-rev-propria@demo.safeworkengenharia.com.br');
      const intruso = await inserirUsuario(pool, empresaA, 'intruso-rev@demo.safeworkengenharia.com.br');
      const joana = await inserirUsuario(pool, empresaA, 'joana-rev-propria@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: carlos, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });
      const delegada = await servico.delegar(pool, { empresaId: empresaA, concedidoPor: carlos, origemId: origem.id, usuarioId: joana });
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      await esperarHttpError(servico.revogar(pool, { empresaId: empresaA, revogadoPor: intruso, autorizacaoId: delegada.id }), 403, 'REVOGACAO_NAO_AUTORIZADA');
      await esperarHttpError(servico.revogar(pool, { empresaId: empresaA, revogadoPor: joana, autorizacaoId: delegada.id }), 403, 'REVOGACAO_NAO_AUTORIZADA');
      await esperarHttpError(servico.revogar(pool, { empresaId: empresaA, revogadoPor: carlos, autorizacaoId: origem.id }), 403, 'REVOGACAO_NAO_AUTORIZADA');
      assert.ok(await lerAutorizacao(pool, delegada.id));
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'recusas não são auditadas');

      await servico.revogar(pool, { empresaId: empresaA, revogadoPor: carlos, autorizacaoId: delegada.id });
      assert.equal(await lerAutorizacao(pool, delegada.id), null);
    });

    test('isolamento multiempresa: o MASTER de A não enxerga nem revoga autorização de B (404), e B continua intacta', async () => {
      const deB = await inserirUsuario(pool, empresaB, 'alvo-rev-b@demo.safeworkengenharia.com.br');
      const autorizacaoB = await servico.concederDireta(pool, { empresaId: empresaB, concedidoPor: masterB, usuarioId: deB, acaoCodigo: ACAO_ALTERNATIVA });

      await esperarHttpError(servico.revogar(pool, { empresaId: empresaA, revogadoPor: masterA, autorizacaoId: autorizacaoB.id }), 404, 'AUTORIZACAO_NAO_ENCONTRADA');
      await esperarHttpError(servico.revogar(pool, { empresaId: empresaB, revogadoPor: masterA, autorizacaoId: autorizacaoB.id }), 403, 'REVOGACAO_NAO_AUTORIZADA');

      assert.ok(await lerAutorizacao(pool, autorizacaoB.id));
    });

    test('alterar pode_delegar para false não é revogação: a delegação já feita permanece; só novas delegações ficam impedidas', async () => {
      const carlos = await inserirUsuario(pool, empresaA, 'carlos-toggle@demo.safeworkengenharia.com.br');
      const joana = await inserirUsuario(pool, empresaA, 'joana-toggle@demo.safeworkengenharia.com.br', 'USUARIO');
      const rui = await inserirUsuario(pool, empresaA, 'rui-toggle@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: carlos, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });
      const delegada = await servico.delegar(pool, { empresaId: empresaA, concedidoPor: carlos, origemId: origem.id, usuarioId: joana });

      await pool.query('UPDATE usuario_autorizacoes SET pode_delegar = false WHERE id = $1', [origem.id]);

      assert.ok(await lerAutorizacao(pool, delegada.id), 'a delegação já concedida sobrevive');
      await esperarHttpError(servico.delegar(pool, { empresaId: empresaA, concedidoPor: carlos, origemId: origem.id, usuarioId: rui }), 403, 'DELEGACAO_NAO_AUTORIZADA');
    });
  });

  describe('segurança transacional', () => {
    test('falha real da auditoria após o INSERT: ROLLBACK — nenhuma autorização e nenhum log gravados', async (t) => {
      const alvo = await inserirUsuario(pool, empresaA, 'alvo-rollback@demo.safeworkengenharia.com.br');
      const autorizacoesAntes = await contarAutorizacoes(pool, empresaA);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada depois do INSERT'); });

      await assert.rejects(servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: alvo, acaoCodigo: ACAO_ALTERNATIVA }), /falha simulada/);

      assert.equal(await contarAutorizacoes(pool, empresaA), autorizacoesAntes, 'o INSERT foi desfeito');
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, alvo, ACAO_ALTERNATIVA), false);
    });

    test('falha real da auditoria após o DELETE de uma origem com descendentes: ROLLBACK — origem e cadeia inteira permanecem', async (t) => {
      const raiz = await inserirUsuario(pool, empresaA, 'raiz-rollback@demo.safeworkengenharia.com.br');
      const filho = await inserirUsuario(pool, empresaA, 'filho-rollback@demo.safeworkengenharia.com.br', 'USUARIO');
      const oRaiz = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: raiz, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });
      const oFilho = await servico.delegar(pool, { empresaId: empresaA, concedidoPor: raiz, origemId: oRaiz.id, usuarioId: filho });
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada depois do DELETE'); });

      await assert.rejects(servico.revogar(pool, { empresaId: empresaA, revogadoPor: masterA, autorizacaoId: oRaiz.id }), /falha simulada/);

      assert.ok(await lerAutorizacao(pool, oRaiz.id), 'a origem voltou');
      assert.ok(await lerAutorizacao(pool, oFilho.id), 'o descendente que a cascata teria removido voltou');
    });

    test('concorrência: revogação da origem enquanto uma delegação a partir dela está em curso — a delegação não se baseia em autoridade revogada', async () => {
      const carlos = await inserirUsuario(pool, empresaA, 'carlos-corrida@demo.safeworkengenharia.com.br');
      const joana = await inserirUsuario(pool, empresaA, 'joana-corrida@demo.safeworkengenharia.com.br', 'USUARIO');
      const origem = await servico.concederDireta(pool, { empresaId: empresaA, concedidoPor: masterA, usuarioId: carlos, acaoCodigo: ACAO_ALTERNATIVA, podeDelegar: true });

      // Transação externa trava a origem (como faria uma revogação em curso)
      // e a exclui; a delegação concorrente fica bloqueada no FOR UPDATE e,
      // ao ser liberada, não encontra mais a origem.
      const externa = await pool.connect();
      try {
        await externa.query('BEGIN');
        await externa.query('SELECT id FROM usuario_autorizacoes WHERE id = $1 FOR UPDATE', [origem.id]);

        const delegacao = servico.delegar(pool, { empresaId: empresaA, concedidoPor: carlos, origemId: origem.id, usuarioId: joana });
        // Dá tempo de a delegação chegar ao FOR UPDATE e bloquear.
        await new Promise((resolve) => { setTimeout(resolve, 150); });
        await externa.query('DELETE FROM usuario_autorizacoes WHERE id = $1', [origem.id]);
        await externa.query('COMMIT');

        await esperarHttpError(delegacao, 403, 'DELEGACAO_NAO_AUTORIZADA');
      } finally {
        externa.release();
      }

      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, joana, ACAO_ALTERNATIVA), false, 'nada foi delegado com base numa origem revogada');
    });
  });

  describe('não-interferência', () => {
    test('nada do que este serviço faz altera catálogo de ações, permissões de perfil, grupos, vinculo_sst ou bloqueios de terceiros', async () => {
      const { rows: [acoes] } = await pool.query("SELECT count(*)::int AS total, bool_and(ativo) AS todas_ativas FROM acoes WHERE codigo <> 'ACAO_QUE_NAO_EXISTE'");
      assert.equal(acoes.todas_ativas, true, 'as desativações temporárias dos testes foram revertidas');
      const { rows: [config] } = await pool.query("SELECT exige_sst, modo_autorizacao_individual FROM acoes WHERE codigo = $1", [ACAO_OBRIGATORIA]);
      assert.deepEqual(config, { exige_sst: true, modo_autorizacao_individual: 'OBRIGATORIA' }, 'regras SST do catálogo intactas');
      // logs_auditoria continua append-only: nenhuma linha pode ser apagada nem por este teste.
      await assert.rejects(pool.query('DELETE FROM logs_auditoria WHERE empresa_id = $1', [empresaA]), /append-only/);
    });
  });
});
