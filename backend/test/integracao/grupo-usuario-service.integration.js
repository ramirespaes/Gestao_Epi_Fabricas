'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { abrirPoolTemporario, inserirEmpresa } = require('./helpers/schema-temporario');
const servico = require('../../src/services/grupo-usuario.service');
const grupoServico = require('../../src/services/grupo-acesso.service');
const permissaoServico = require('../../src/services/grupo-permissao.service');
const auditoriaRepo = require('../../src/repositories/auditoria.repository');
const permissoes = require('../../src/repositories/permissao.repository');
const { HttpError } = require('../../src/errors/HttpError');

/**
 * Serviço de vinculação de usuários a grupos contra PostgreSQL real
 * (Bloco 8, Incremento 8, Etapa 5A, Subetapa 3L): transações, FOR UPDATE,
 * a FK composta da migration 020, a trilha em logs_auditoria com as
 * triggers das 012/014 ativas — e, sobretudo, a confirmação de que o que
 * o MIDDLEWARE lê (via permissao.repository, intocado) muda exatamente
 * como se espera, e de que exceções individuais, bloqueios e vinculo_sst
 * atravessam a operação sem um arranhão.
 *
 * Schema temporário exclusivo, removido em cascata ao final.
 */

// 004 e 006 entram por causa de `funcionarios`: esta subetapa precisa
// PROVAR que vincular alguém ao grupo chamado "Funcionários" não cria
// cadastro de funcionário — e isso só é demonstrável com a tabela
// realmente presente no schema.
const MIGRATIONS = ['000', '001', '002', '003', '004', '005', '006', '009', '010', '011', '012', '013', '014', '016', '017', '018', '019', '020', '021', '022', '023'];

const HASH = '$argon2id$v=19$m=65536,t=3,p=1$c2ludGV0aWNv$aGFzaGZha2VzaW50ZXRpY28';
const RECURSO = 'materials';
const ACAO_ALTERNATIVA = 'MOVIMENTAR_ESTOQUE';

async function inserirUsuario(pool, empresaId, email, perfil = 'ADMINISTRADOR', ativo = true) {
  const { rows } = await pool.query(
    'INSERT INTO usuarios (empresa_id, nome, email, senha_hash, perfil, ativo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id',
    [empresaId, `Usuário ${email}`, email, HASH, perfil, ativo],
  );
  return rows[0].id;
}

async function lerGrupoDoUsuario(pool, usuarioId) {
  const { rows } = await pool.query('SELECT grupo_acesso_id, ativo, perfil FROM usuarios WHERE id = $1', [usuarioId]);
  return rows[0] ?? null;
}

async function lerAuditoria(pool, empresaId, acao, referencia) {
  const { rows } = await pool.query(
    'SELECT * FROM logs_auditoria WHERE empresa_id = $1 AND acao = $2 AND referencia = $3 ORDER BY id',
    [empresaId, acao, referencia],
  );
  return rows;
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

describe('serviço de vínculo usuário-grupo em PostgreSQL real', () => {
  let contexto;
  let pool;
  let empresaA;
  let empresaB;
  let masterA;
  let masterB;
  let adminA;

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
    adminA = await inserirUsuario(pool, empresaA, 'admin-a@demo.safeworkengenharia.com.br', 'ADMINISTRADOR');
  });

  after(async () => { if (contexto) await contexto.encerrar(); });

  const criarGrupo = (nome, { empresaId = empresaA, atorId = masterA } = {}) => grupoServico.criar(pool, { empresaId, atorId, nome });

  describe('vincular, transferir e retirar', () => {
    test('MASTER vincula usuário: o RBAC passa a enxergar o grupo, e a auditoria registra anterior/novo', async () => {
      const grupo = await criarGrupo('Vinculação Simples');
      const usuario = await inserirUsuario(pool, empresaA, 'vinculado@demo.safeworkengenharia.com.br');

      assert.equal(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, usuario), null, 'antes: sem grupo');

      const resultado = await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: grupo.id });

      assert.deepEqual(resultado, { usuarioId: usuario, grupoAnteriorId: null, grupoAtualId: grupo.id, alterado: true });
      assert.equal((await lerGrupoDoUsuario(pool, usuario)).grupo_acesso_id, grupo.id);
      assert.deepEqual(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, usuario), { id: grupo.id, ativo: true });

      const [auditoria] = await lerAuditoria(pool, empresaA, 'USUARIO_VINCULADO_A_GRUPO', String(usuario));
      assert.equal(auditoria.usuario_id, masterA, 'o ator');
      assert.deepEqual(auditoria.dados_anteriores, { grupoAcessoId: null });
      assert.deepEqual(auditoria.dados_novos, { grupoAcessoId: grupo.id });
      assert.equal(auditoria.contexto.usuarioAfetado, usuario);
    });

    test('troca de grupo substitui o vínculo sem alterar a configuração de nenhum dos dois grupos', async () => {
      const origem = await criarGrupo('Origem da Troca');
      const destino = await criarGrupo('Destino da Troca');
      const usuario = await inserirUsuario(pool, empresaA, 'transferido@demo.safeworkengenharia.com.br');
      await permissaoServico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: origem.id, recurso: RECURSO, podeVisualizar: false,
      });
      await permissaoServico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: destino.id, recurso: RECURSO, podeVisualizar: true,
      });
      await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: origem.id });

      const resultado = await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: destino.id });

      assert.deepEqual(resultado, { usuarioId: usuario, grupoAnteriorId: origem.id, grupoAtualId: destino.id, alterado: true });
      assert.deepEqual(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, usuario), { id: destino.id, ativo: true });
      // As permissões dos dois grupos continuam exatamente como estavam.
      assert.equal((await permissoes.buscarPermissaoRecursoGrupo(pool, empresaA, origem.id, RECURSO)).podeVisualizar, false);
      assert.equal((await permissoes.buscarPermissaoRecursoGrupo(pool, empresaA, destino.id, RECURSO)).podeVisualizar, true);

      const [auditoria] = await lerAuditoria(pool, empresaA, 'USUARIO_TRANSFERIDO_DE_GRUPO', String(usuario));
      assert.deepEqual(auditoria.dados_anteriores, { grupoAcessoId: origem.id });
      assert.deepEqual(auditoria.dados_novos, { grupoAcessoId: destino.id });
    });

    test('retirar do grupo restaura o piso do perfil: a negação do grupo deixa de valer', async () => {
      const grupo = await criarGrupo('Grupo Restritivo');
      const usuario = await inserirUsuario(pool, empresaA, 'restrito@demo.safeworkengenharia.com.br');
      // O grupo NEGA o recurso; o perfil, por si, não tem opinião aqui.
      await permissaoServico.configurarRecurso(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, recurso: RECURSO, podeVisualizar: false,
      });
      await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: grupo.id });
      assert.deepEqual(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, usuario), { id: grupo.id, ativo: true });

      const resultado = await servico.desvincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario });

      assert.deepEqual(resultado, { usuarioId: usuario, grupoAnteriorId: grupo.id, grupoAtualId: null, alterado: true });
      assert.equal((await lerGrupoDoUsuario(pool, usuario)).grupo_acesso_id, null);
      assert.equal(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, usuario), null,
        'sem grupo, o middleware volta a decidir só pelo perfil e pelas exceções individuais');
      // A configuração do grupo continua lá, para quem mais estiver nele.
      assert.equal((await permissoes.buscarPermissaoRecursoGrupo(pool, empresaA, grupo.id, RECURSO)).podeVisualizar, false);

      const [auditoria] = await lerAuditoria(pool, empresaA, 'USUARIO_DESVINCULADO_DE_GRUPO', String(usuario));
      assert.equal(auditoria.contexto.efeito, 'VOLTA_AO_PISO_DO_PERFIL');
      assert.deepEqual(auditoria.dados_anteriores, { grupoAcessoId: grupo.id });
      assert.deepEqual(auditoria.dados_novos, { grupoAcessoId: null });
    });

    test('sem mudança efetiva: vincular ao mesmo grupo e desvincular quem não tem grupo não gravam nem auditam', async () => {
      const grupo = await criarGrupo('Sem Mudança Vínculo');
      const usuario = await inserirUsuario(pool, empresaA, 'sem-mudanca-vinculo@demo.safeworkengenharia.com.br');
      await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: grupo.id });
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      const repetido = await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: grupo.id });
      assert.equal(repetido.alterado, false);

      const semGrupo = await inserirUsuario(pool, empresaA, 'nunca-teve-grupo@demo.safeworkengenharia.com.br');
      const retirado = await servico.desvincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: semGrupo });
      assert.equal(retirado.alterado, false);

      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'nada auditado');
    });
  });

  describe('autoridade e recusas', () => {
    test('não-MASTER e MASTER inativo recebem 403, sem alterar nada', async () => {
      const grupo = await criarGrupo('Protegido Vínculo');
      const usuario = await inserirUsuario(pool, empresaA, 'alvo-protegido@demo.safeworkengenharia.com.br');
      const masterInativo = await inserirUsuario(pool, empresaA, 'master-inativo-vinc@demo.safeworkengenharia.com.br', 'MASTER', false);
      const auditoriaAntes = await contarAuditoria(pool, empresaA);

      await esperarHttpError(servico.vincular(pool, { empresaId: empresaA, atorId: adminA, usuarioId: usuario, grupoId: grupo.id }), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');
      await esperarHttpError(servico.vincular(pool, { empresaId: empresaA, atorId: masterInativo, usuarioId: usuario, grupoId: grupo.id }), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');
      await esperarHttpError(servico.desvincular(pool, { empresaId: empresaA, atorId: adminA, usuarioId: usuario }), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');

      assert.equal((await lerGrupoDoUsuario(pool, usuario)).grupo_acesso_id, null);
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes, 'recusa não é auditada');
    });

    test('o MASTER não altera o próprio grupo', async () => {
      const grupo = await criarGrupo('Autovínculo');

      await esperarHttpError(servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: masterA, grupoId: grupo.id }), 409, 'AUTOVINCULO_NAO_PERMITIDO');
      await esperarHttpError(servico.desvincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: masterA }), 409, 'AUTOVINCULO_NAO_PERMITIDO');

      assert.equal((await lerGrupoDoUsuario(pool, masterA)).grupo_acesso_id, null);
    });

    test('usuário de perfil MASTER não recebe grupo', async () => {
      const grupo = await criarGrupo('Para Master');
      const outroMaster = await inserirUsuario(pool, empresaA, 'outro-master-vinc@demo.safeworkengenharia.com.br', 'MASTER');

      await esperarHttpError(servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: outroMaster, grupoId: grupo.id }), 409, 'USUARIO_MASTER_SEM_GRUPO');

      assert.equal((await lerGrupoDoUsuario(pool, outroMaster)).grupo_acesso_id, null);
    });

    test('usuário inativo não recebe vínculo novo, e seu vínculo histórico é preservado', async () => {
      const grupo = await criarGrupo('Histórico Preservado');
      const outroGrupo = await criarGrupo('Destino Proibido');
      const usuario = await inserirUsuario(pool, empresaA, 'sera-inativado@demo.safeworkengenharia.com.br');
      await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: grupo.id });
      await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [usuario]);

      await esperarHttpError(servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: outroGrupo.id }), 409, 'USUARIO_INATIVO');
      await esperarHttpError(servico.desvincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario }), 409, 'USUARIO_INATIVO');

      const linha = await lerGrupoDoUsuario(pool, usuario);
      assert.equal(linha.grupo_acesso_id, grupo.id, 'o vínculo histórico continua intacto');
      assert.equal(linha.ativo, false, 'o estado do usuário não foi alterado por operação de grupo');
    });

    test('usuário e grupo de outra empresa são inacessíveis mesmo conhecendo os ids', async () => {
      const grupoDeA = await criarGrupo('De A');
      const grupoDeB = await criarGrupo('De B', { empresaId: empresaB, atorId: masterB });
      const usuarioDeB = await inserirUsuario(pool, empresaB, 'usuario-de-b@demo.safeworkengenharia.com.br');
      const usuarioDeA = await inserirUsuario(pool, empresaA, 'usuario-de-a@demo.safeworkengenharia.com.br');

      // MASTER de A tentando usar o usuário de B, na empresa A: usuário não existe aqui.
      await esperarHttpError(servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuarioDeB, grupoId: grupoDeA.id }), 404, 'USUARIO_NAO_ENCONTRADO');
      // MASTER de A tentando usar o grupo de B: grupo não existe aqui.
      await esperarHttpError(servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuarioDeA, grupoId: grupoDeB.id }), 404, 'GRUPO_NAO_ENCONTRADO');
      // MASTER de A tentando agir dentro da empresa B: nem ator ele é lá.
      await esperarHttpError(servico.vincular(pool, { empresaId: empresaB, atorId: masterA, usuarioId: usuarioDeB, grupoId: grupoDeB.id }), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');

      assert.equal((await lerGrupoDoUsuario(pool, usuarioDeB)).grupo_acesso_id, null);
      assert.equal((await lerGrupoDoUsuario(pool, usuarioDeA)).grupo_acesso_id, null);
    });
  });

  describe('grupos inativos', () => {
    test('grupo inativo não recebe vínculo novo', async () => {
      const grupo = await criarGrupo('Inativo Sem Novos');
      const usuario = await inserirUsuario(pool, empresaA, 'sem-entrar-inativo@demo.safeworkengenharia.com.br');
      await grupoServico.inativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      await esperarHttpError(servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: grupo.id }), 409, 'GRUPO_INATIVO');

      assert.equal((await lerGrupoDoUsuario(pool, usuario)).grupo_acesso_id, null);
    });

    test('quem já estava no grupo continua vinculado quando ele é inativado, e o MASTER pode retirar ou transferir depois', async () => {
      const grupo = await criarGrupo('Inativado Com Gente');
      const destino = await criarGrupo('Refúgio Ativo');
      const ficaNoGrupo = await inserirUsuario(pool, empresaA, 'fica-no-inativo@demo.safeworkengenharia.com.br');
      const seraTransferido = await inserirUsuario(pool, empresaA, 'sera-transferido@demo.safeworkengenharia.com.br');
      const seraRetirado = await inserirUsuario(pool, empresaA, 'sera-retirado@demo.safeworkengenharia.com.br');
      for (const usuario of [ficaNoGrupo, seraTransferido, seraRetirado]) {
        await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: grupo.id });
      }

      await grupoServico.inativar(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      // Vínculos preservados, e o middleware passa a ver o grupo como inativo.
      assert.equal((await lerGrupoDoUsuario(pool, ficaNoGrupo)).grupo_acesso_id, grupo.id);
      assert.deepEqual(await permissoes.buscarGrupoAcessoDoUsuario(pool, empresaA, ficaNoGrupo), { id: grupo.id, ativo: false });

      // E o MASTER ainda consegue transferir e retirar.
      await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: seraTransferido, grupoId: destino.id });
      await servico.desvincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: seraRetirado });

      assert.equal((await lerGrupoDoUsuario(pool, seraTransferido)).grupo_acesso_id, destino.id);
      assert.equal((await lerGrupoDoUsuario(pool, seraRetirado)).grupo_acesso_id, null);
      assert.equal((await lerGrupoDoUsuario(pool, ficaNoGrupo)).grupo_acesso_id, grupo.id, 'quem não foi mexido continua lá');

      // Nada reativou o grupo.
      const { rows: [linhaGrupo] } = await pool.query('SELECT ativo FROM grupos_acesso WHERE id = $1', [grupo.id]);
      assert.equal(linhaGrupo.ativo, false);
    });
  });

  describe('separação de domínios e preservação do RBAC', () => {
    test('vincular ao grupo "Funcionários" não cria funcionário, e ao grupo "SST" não cria vinculo_sst', async () => {
      const funcionarios = await criarGrupo('Funcionários');
      const sst = await criarGrupo('SST');
      const usuario1 = await inserirUsuario(pool, empresaA, 'no-grupo-funcionarios@demo.safeworkengenharia.com.br');
      const usuario2 = await inserirUsuario(pool, empresaA, 'no-grupo-sst@demo.safeworkengenharia.com.br');
      const { rows: [antes] } = await pool.query(
        'SELECT (SELECT count(*)::int FROM funcionarios) AS func, (SELECT count(*)::int FROM vinculo_sst) AS sst',
      );

      await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario1, grupoId: funcionarios.id });
      await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario2, grupoId: sst.id });

      const { rows: [depois] } = await pool.query(
        'SELECT (SELECT count(*)::int FROM funcionarios) AS func, (SELECT count(*)::int FROM vinculo_sst) AS sst',
      );
      assert.equal(depois.func, antes.func, 'nenhum funcionário criado: usuarios e funcionarios são coisas distintas');
      assert.equal(depois.sst, antes.sst, 'nenhum vinculo_sst criado');
      assert.equal(await permissoes.usuarioIntegraSst(pool, empresaA, usuario2), false);
    });

    test('exceções individuais, bloqueios e vinculo_sst atravessam vínculo e desvínculo intactos', async () => {
      const grupo = await criarGrupo('Convive Com Exceções');
      const usuario = await inserirUsuario(pool, empresaA, 'com-excecoes@demo.safeworkengenharia.com.br');
      await pool.query(
        `INSERT INTO usuario_permissoes_recurso (empresa_id, usuario_id, recurso, pode_visualizar, concedido_por)
         VALUES ($1, $2, $3, true, $4)`,
        [empresaA, usuario, RECURSO, masterA],
      );
      await pool.query(
        'INSERT INTO usuario_autorizacoes (empresa_id, usuario_id, acao_codigo, autorizado_por) VALUES ($1, $2, $3, $4)',
        [empresaA, usuario, ACAO_ALTERNATIVA, masterA],
      );
      await pool.query('INSERT INTO usuario_bloqueios (usuario_id, acao_codigo) VALUES ($1, $2)', [usuario, 'REALIZAR_ENTREGA']);
      await pool.query('INSERT INTO vinculo_sst (usuario_id, empresa_id, concedido_por) VALUES ($1, $2, $3)', [usuario, empresaA, masterA]);

      await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: grupo.id });
      await servico.desvincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario });

      assert.equal((await permissoes.buscarPermissaoRecursoIndividual(pool, empresaA, usuario, RECURSO)).podeVisualizar, true,
        'exceção individual de recurso preservada');
      assert.equal(await permissoes.usuarioTemAutorizacaoIndividual(pool, empresaA, usuario, ACAO_ALTERNATIVA), true,
        'autorização individual de ação preservada');
      assert.equal(await permissoes.usuarioTemBloqueio(pool, empresaA, usuario, 'REALIZAR_ENTREGA'), true,
        'bloqueio individual preservado');
      assert.equal(await permissoes.usuarioIntegraSst(pool, empresaA, usuario), true, 'vinculo_sst preservado');
    });

    test('nenhuma operação altera grupos_acesso, permissões de grupo, perfis ou o catálogo', async () => {
      const grupo = await criarGrupo('Sem Efeito Colateral Vínculo');
      const usuario = await inserirUsuario(pool, empresaA, 'sem-efeito-vinculo@demo.safeworkengenharia.com.br');
      await permissaoServico.configurarAcao(pool, {
        empresaId: empresaA, atorId: masterA, grupoId: grupo.id, acaoCodigo: ACAO_ALTERNATIVA, permitido: true,
      });
      const { rows: [antes] } = await pool.query(`
        SELECT (SELECT count(*)::int FROM grupos_acesso WHERE empresa_id = $1) AS grupos,
               (SELECT count(*)::int FROM grupo_permissoes_recurso WHERE empresa_id = $1) AS gpr,
               (SELECT count(*)::int FROM grupo_permissoes_acao WHERE empresa_id = $1) AS gpa,
               (SELECT count(*)::int FROM permissoes_recurso) AS pr,
               (SELECT count(*)::int FROM permissoes_acao) AS pa,
               (SELECT count(*)::int FROM acoes WHERE ativo) AS acoes_ativas`, [empresaA]);

      await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: grupo.id });
      await servico.listarUsuariosDoGrupo(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });
      await servico.desvincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario });

      const { rows: [depois] } = await pool.query(`
        SELECT (SELECT count(*)::int FROM grupos_acesso WHERE empresa_id = $1) AS grupos,
               (SELECT count(*)::int FROM grupo_permissoes_recurso WHERE empresa_id = $1) AS gpr,
               (SELECT count(*)::int FROM grupo_permissoes_acao WHERE empresa_id = $1) AS gpa,
               (SELECT count(*)::int FROM permissoes_recurso) AS pr,
               (SELECT count(*)::int FROM permissoes_acao) AS pa,
               (SELECT count(*)::int FROM acoes WHERE ativo) AS acoes_ativas`, [empresaA]);

      assert.deepEqual(depois, antes, 'a única coluna tocada foi usuarios.grupo_acesso_id');
      assert.equal((await permissoes.buscarPermissaoAcaoGrupo(pool, empresaA, grupo.id, ACAO_ALTERNATIVA)).permitido, true);
    });
  });

  describe('listagem', () => {
    test('lista os usuários do grupo da própria empresa, incluindo inativos; grupo de outra empresa é 404', async () => {
      const grupo = await criarGrupo('Com Membros');
      const grupoDeB = await criarGrupo('Membros de B', { empresaId: empresaB, atorId: masterB });
      const ativo = await inserirUsuario(pool, empresaA, 'membro-ativo@demo.safeworkengenharia.com.br');
      const seraInativado = await inserirUsuario(pool, empresaA, 'membro-inativado@demo.safeworkengenharia.com.br');
      await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: ativo, grupoId: grupo.id });
      await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: seraInativado, grupoId: grupo.id });
      await pool.query('UPDATE usuarios SET ativo = false WHERE id = $1', [seraInativado]);

      const membros = await servico.listarUsuariosDoGrupo(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupo.id });

      assert.equal(membros.length, 2, 'inativos continuam visíveis para a administração');
      assert.equal(membros.some((m) => m.id === seraInativado && m.ativo === false), true);
      assert.equal(membros.every((m) => 'senha_hash' in m === false), true, 'nunca credencial');

      await esperarHttpError(servico.listarUsuariosDoGrupo(pool, { empresaId: empresaA, atorId: masterA, grupoId: grupoDeB.id }), 404, 'GRUPO_NAO_ENCONTRADO');
    });

    // Ajuste da Subetapa 3O: a listagem passou a exigir a mesma autoridade
    // administrativa das operações de escrita deste serviço (mesma decisão
    // já tomada para grupo-acesso.service.js na 3M e grupo-permissao.service.js na 3N).
    test('ADMINISTRADOR sem autoridade recebe 403, contra PostgreSQL real', async () => {
      const grupo = await criarGrupo('Listagem Sem Autoridade Vinculo');

      await esperarHttpError(servico.listarUsuariosDoGrupo(pool, { empresaId: empresaA, atorId: adminA, grupoId: grupo.id }), 403, 'GRUPO_VINCULO_NAO_AUTORIZADO');
    });
  });

  describe('segurança transacional', () => {
    test('falha real da auditoria após vincular: ROLLBACK — o usuário continua sem grupo', async (t) => {
      const grupo = await criarGrupo('Rollback Vínculo');
      const usuario = await inserirUsuario(pool, empresaA, 'rollback-vinculo@demo.safeworkengenharia.com.br');
      const auditoriaAntes = await contarAuditoria(pool, empresaA);
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada depois do UPDATE'); });

      await assert.rejects(servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: grupo.id }), /falha simulada/);

      assert.equal((await lerGrupoDoUsuario(pool, usuario)).grupo_acesso_id, null, 'o UPDATE foi desfeito');
      assert.equal(await contarAuditoria(pool, empresaA), auditoriaAntes);
    });

    test('falha real da auditoria após desvincular: ROLLBACK — o vínculo anterior é restaurado', async (t) => {
      const grupo = await criarGrupo('Rollback Desvínculo');
      const usuario = await inserirUsuario(pool, empresaA, 'rollback-desvinculo@demo.safeworkengenharia.com.br');
      await servico.vincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario, grupoId: grupo.id });
      t.mock.method(auditoriaRepo, 'registrar', async () => { throw new Error('falha simulada'); });

      await assert.rejects(servico.desvincular(pool, { empresaId: empresaA, atorId: masterA, usuarioId: usuario }), /falha simulada/);

      assert.equal((await lerGrupoDoUsuario(pool, usuario)).grupo_acesso_id, grupo.id, 'o vínculo voltou');
    });

    test('logs_auditoria continua append-only', async () => {
      await assert.rejects(pool.query('DELETE FROM logs_auditoria WHERE empresa_id = $1', [empresaA]), /append-only/);
    });
  });
});
