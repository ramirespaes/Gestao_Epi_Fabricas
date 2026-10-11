'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const { montar } = require('./helpers/gestao-usuarios-app');
const provisionamento = require('../../src/services/provisionamento-permissoes.service');
const { criarGrupoPermissaoController } = require('../../src/controllers/grupo-permissao.controller');
const { criarGrupoPermissaoRoutes } = require('../../src/routes/grupo-permissao.routes');

/**
 * Histórico de Funcionários — pacote J (RED): permissão "Exportar Histórico de Funcionários" (PostgreSQL real, schema
 * temporário com todas as migrations).
 *
 * Contrato proposto (desenho de IMPORTAR_FUNCIONARIOS, migration 078):
 *   - ação EXPORTAR_HISTORICO_FUNCIONARIOS, modo ALTERNATIVA, sem SST; nasce negada para todos os perfis comuns;
 *   - toggle `exportarHistoricoFuncionarios` no usuário (efeito real) e no grupo (configuração do grupo);
 *   - GET /auth/permissoes traz `acoes.EXPORTAR_HISTORICO_FUNCIONARIOS` (booleano, como as demais ações);
 *   - a autorização FINAL da futura exportação (pacote I) é a de src/services/exportacao-historico-autorizacao.service.js:
 *     `avaliar(executor, { empresaId, usuarioId, perfil })` → { visualizar, exportar, permitido }, com
 *     permitido = visualizar (employeeHistory.visualizar efetivo) E exportar (a ação efetiva). Nenhuma rota de
 *     exportação existe neste pacote.
 *   - MASTER: autoridade pelo provisionamento (escopo do MASTER), fixo na tela, sem gravação individual.
 */

const CODIGO = 'EXPORTAR_HISTORICO_FUNCIONARIOS';
const TOGGLE = 'exportarHistoricoFuncionarios';
const AVISO = 'EXPORTAR_HISTORICO_SEM_VISUALIZAR';
const MODULO = path.join(__dirname, '..', '..', 'src', 'services', 'exportacao-historico-autorizacao.service.js');

function autorizacaoExportacao() {
  assert.ok(fs.existsSync(MODULO), 'serviço de autorização da exportação ausente (src/services/exportacao-historico-autorizacao.service.js)');
  const modulo = require(MODULO);
  assert.equal(typeof modulo.avaliar, 'function', 'avaliar(executor, contexto) ausente');
  return modulo;
}

describe('J — permissão de exportar o Histórico de Funcionários (PostgreSQL real)', () => {
  let g;
  let master;
  const contas = {};

  before(async () => {
    g = await montar({ extras: ({ pool, exigirEmpresarial }) => [
      criarGrupoPermissaoRoutes({ controller: criarGrupoPermissaoController({ pool }), exigirSessao: exigirEmpresarial }),
    ] });
    await provisionamento.provisionar(g.pool, { empresaId: g.empresas.A, dryRun: false });
    master = await g.contaDaEmpresa(g.empresas.A);
    for (const perfil of ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) contas[perfil] = await g.contaDaEmpresa(g.empresas.A, perfil);
  });
  after(async () => { if (g) await g.encerrar(); });

  const novaConta = (perfil = 'USUARIO', empresaId = g.empresas.A) => g.contaDaEmpresa(empresaId, perfil);
  const acessosDe = async (alvo) => {
    const r = await g.request(g.app).get(`/api/administracao/usuarios/${alvo.usuarioId}/acessos`).set('Cookie', g.cookie(master));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body.acessos;
  };
  const toggleDe = async (alvo, id) => (await acessosDe(alvo)).toggles.find((t) => t.id === id);
  const ligar = async (alvo, id, ligado) => {
    const r = await g.request(g.app).put(`/api/administracao/usuarios/${alvo.usuarioId}/acessos/${id}`).set('Cookie', g.cookie(master)).send({ ligado });
    assert.equal(r.status, 200, `${id}=${ligado}: ${JSON.stringify(r.body)}`);
    return r.body;
  };
  const efetivas = async (c) => {
    const r = await g.request(g.app).get('/api/auth/permissoes').set('Cookie', g.cookie(c));
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return r.body;
  };
  const exportarEfetivo = async (c) => {
    const corpo = await efetivas(c);
    assert.equal(typeof corpo.acoes[CODIGO], 'boolean', `/auth/permissoes sem acoes.${CODIGO}: ${JSON.stringify(Object.keys(corpo.acoes))}`);
    return corpo.acoes[CODIGO];
  };
  const avaliar = (c, perfil) => autorizacaoExportacao().avaliar(g.pool, { empresaId: c.empresaId, usuarioId: c.usuarioId, perfil });
  const codigos = (corpo) => (corpo.avisos ?? []).map((a) => a.codigo);

  describe('JI1 — catálogo e estado inicial', () => {
    test('JI1.1 a tela do usuário lista "Exportar Histórico de Funcionários" em Colaboradores, desligado e editável', async () => {
      const t = await toggleDe(contas.USUARIO, TOGGLE);
      assert.ok(t, 'toggle ausente na resposta de acessos');
      assert.deepEqual([t.rotulo, t.grupo, t.ligado, t.fixo], ['Exportar Histórico de Funcionários', 'COLABORADORES', false, false]);
    });

    test('JI1.2 nasce NEGADA para ADMINISTRADOR, SUPERVISOR e USUARIO: /auth/permissoes, tela e autorização final', async () => {
      for (const perfil of ['ADMINISTRADOR', 'SUPERVISOR', 'USUARIO']) {
        assert.equal(await exportarEfetivo(contas[perfil]), false, perfil);
        assert.equal((await toggleDe(contas[perfil], TOGGLE))?.ligado, false, perfil);
        assert.deepEqual(await avaliar(contas[perfil], perfil), { visualizar: false, exportar: false, permitido: false }, perfil);
      }
    });

    test('JI1.3 a ação existe no catálogo do banco: ativa, ALTERNATIVA, sem SST; nenhuma concessão gravada', async () => {
      const acao = await g.um('SELECT ativo, modo_autorizacao_individual, exige_sst FROM acoes WHERE codigo = $1', [CODIGO]);
      assert.deepEqual(acao, { ativo: true, modo_autorizacao_individual: 'ALTERNATIVA', exige_sst: false });
      for (const tabela of ['grupo_permissoes_acao', 'usuario_autorizacoes', 'usuario_bloqueios']) {
        assert.equal((await g.um(`SELECT count(*)::int AS n FROM ${tabela} WHERE acao_codigo = $1`, [CODIGO])).n, 0, tabela);
      }
      const perfis = await g.todos('SELECT DISTINCT perfil FROM permissoes_acao WHERE acao_codigo = $1 AND permitido', [CODIGO]);
      assert.deepEqual(perfis.map((p) => p.perfil), ['MASTER'], 'só o MASTER, pelo provisionamento');
    });
  });

  describe('JI2 — independência e regra das duas permissões', () => {
    test('JI2.1 visualizar ligado e exportar desligado: vê o histórico, não exporta', async () => {
      const c = await novaConta();
      await ligar(c, 'historicoFuncionarios', true);
      const corpo = await efetivas(c);
      assert.equal(corpo.recursos.employeeHistory.visualizar, true);
      assert.equal(await exportarEfetivo(c), false, 'visualizar não concede exportar');
      assert.deepEqual(await avaliar(c, 'USUARIO'), { visualizar: true, exportar: false, permitido: false });
    });

    test('JI2.2 exportar ligado e visualizar desligado: toggle ligado, ação efetiva, mas a autorização final NEGA; aviso no PUT e no GET', async () => {
      const c = await novaConta();
      const put = await ligar(c, TOGGLE, true);
      assert.equal(put.acesso.ligado, true);
      assert.deepEqual(codigos(put), [AVISO]);
      assert.deepEqual(codigos(await acessosDe(c)), [AVISO]);
      const corpo = await efetivas(c);
      assert.equal(corpo.recursos.employeeHistory.visualizar, false, 'ligar exportar não liga visualizar');
      assert.equal(corpo.acoes[CODIGO], true);
      assert.deepEqual(await avaliar(c, 'USUARIO'), { visualizar: false, exportar: true, permitido: false });
    });

    test('JI2.3 os dois ligados: autorizado; sem aviso', async () => {
      const c = await novaConta('SUPERVISOR');
      await ligar(c, 'historicoFuncionarios', true);
      const put = await ligar(c, TOGGLE, true);
      assert.deepEqual(codigos(put), []);
      assert.deepEqual(await avaliar(c, 'SUPERVISOR'), { visualizar: true, exportar: true, permitido: true });
    });

    test('JI2.4 ligar exportar não concede nada além da ação (nenhum outro toggle muda, nenhuma linha de recurso)', async () => {
      const c = await novaConta('ADMINISTRADOR');
      const antes = Object.fromEntries((await acessosDe(c)).toggles.map((t) => [t.id, t.ligado]));
      await ligar(c, TOGGLE, true);
      const depois = Object.fromEntries((await acessosDe(c)).toggles.map((t) => [t.id, t.ligado]));
      assert.deepEqual({ ...depois, [TOGGLE]: false }, { ...antes, [TOGGLE]: false });
      assert.equal(depois[TOGGLE], true);
      assert.equal((await g.um('SELECT count(*)::int AS n FROM usuario_permissoes_recurso WHERE usuario_id = $1', [c.usuarioId])).n, 0);
      const corpo = await efetivas(c);
      for (const acao of ['IMPORTAR_FUNCIONARIOS', 'GERENCIAR_USUARIOS', 'APROVAR_SOLICITACAO', 'REPROVAR_SOLICITACAO', 'ENCERRAR_SOLICITACAO', 'REALIZAR_ENTREGA']) {
        assert.equal(corpo.acoes[acao], false, acao);
      }
      assert.deepEqual([corpo.recursos.employeeHistory.visualizar, corpo.recursos.employeeHistory.criar, corpo.recursos.employeeHistory.editar], [false, false, false]);
    });

    test('JI2.5 desligar volta ao padrão sem exceção redundante; a auditoria registra só o acesso e o estado', async () => {
      const c = await novaConta();
      await ligar(c, TOGGLE, true);
      const off = await ligar(c, TOGGLE, false);
      assert.equal(off.acesso.ligado, false);
      assert.equal(await exportarEfetivo(c), false);
      for (const tabela of ['usuario_autorizacoes', 'usuario_bloqueios']) {
        assert.equal((await g.um(`SELECT count(*)::int AS n FROM ${tabela} WHERE usuario_id = $1 AND acao_codigo = $2`, [c.usuarioId, CODIGO])).n, 0, tabela);
      }
      const registros = await g.todos("SELECT dados_novos FROM logs_auditoria WHERE acao = 'USUARIO_ACESSO_ALTERADO' AND referencia = $1 ORDER BY id", [String(c.usuarioId)]);
      assert.deepEqual(registros.map((r) => r.dados_novos), [{ acesso: TOGGLE, ligado: true }, { acesso: TOGGLE, ligado: false }]);
    });
  });

  describe('JI3 — grupo, exceções e precedência', () => {
    let n = 0;
    const novoGrupo = async () => {
      n += 1;
      return (await g.um('INSERT INTO grupos_acesso (empresa_id, nome, criado_por) VALUES ($1, $2, $3) RETURNING id', [g.empresas.A, `Grupo exportar ${n}`, master.usuarioId])).id;
    };
    const ligarNoGrupo = async (grupo, id, ligado) => {
      const r = await g.request(g.app).put(`/api/grupos-acesso/${grupo}/acessos/${id}`).set('Cookie', g.cookie(master)).send({ ligado });
      assert.equal(r.status, 200, `${id}=${ligado}: ${JSON.stringify(r.body)}`);
      return r.body;
    };
    const noGrupo = (c, grupo) => g.pool.query('UPDATE usuarios SET grupo_acesso_id = $1 WHERE id = $2', [grupo, c.usuarioId]);

    test('JI3.1 o grupo lista o acesso (ação ALTERNATIVA) e, ligado, concede aos integrantes; desligado retira a opinião (null)', async () => {
      const grupo = await novoGrupo();
      const lista = await g.request(g.app).get(`/api/grupos-acesso/${grupo}/acessos`).set('Cookie', g.cookie(master));
      assert.equal(lista.status, 200, JSON.stringify(lista.body));
      assert.equal(lista.body.acessos.toggles.find((t) => t.id === TOGGLE)?.ligado, false, 'acesso ausente no grupo');
      const c = await novaConta();
      await noGrupo(c, grupo);
      const put = await ligarNoGrupo(grupo, TOGGLE, true);
      assert.deepEqual(codigos(put), [AVISO], 'o grupo concede exportar e não concede o Histórico');
      assert.equal(await exportarEfetivo(c), true);
      assert.deepEqual(await avaliar(c, 'USUARIO'), { visualizar: false, exportar: true, permitido: false });
      await ligarNoGrupo(grupo, 'historicoFuncionarios', true);
      assert.deepEqual(await avaliar(c, 'USUARIO'), { visualizar: true, exportar: true, permitido: true });
      await ligarNoGrupo(grupo, TOGGLE, false);
      const linha = await g.um('SELECT permitido FROM grupo_permissoes_acao WHERE grupo_acesso_id = $1 AND acao_codigo = $2', [grupo, CODIGO]);
      assert.ok(linha === undefined || linha.permitido === null, `OFF não grava false: ${JSON.stringify(linha)}`);
      assert.equal(await exportarEfetivo(c), false);
    });

    test('JI3.2 precedência: o grupo concede, o usuário desliga → bloqueio individual é a última palavra', async () => {
      const grupo = await novoGrupo();
      const c = await novaConta();
      await noGrupo(c, grupo);
      await ligarNoGrupo(grupo, TOGGLE, true);
      await ligarNoGrupo(grupo, 'historicoFuncionarios', true);
      await ligar(c, TOGGLE, false);
      assert.equal(await exportarEfetivo(c), false);
      assert.equal((await g.um('SELECT count(*)::int AS n FROM usuario_bloqueios WHERE usuario_id = $1 AND acao_codigo = $2', [c.usuarioId, CODIGO])).n, 1);
      assert.deepEqual(await avaliar(c, 'USUARIO'), { visualizar: true, exportar: false, permitido: false });
    });

    test('JI3.3 a concessão individual de exportar não contorna a falta de visualizar: o grupo concede a leitura, o usuário a tem negada', async () => {
      const grupo = await novoGrupo();
      const c = await novaConta();
      await noGrupo(c, grupo);
      await ligarNoGrupo(grupo, 'historicoFuncionarios', true);
      await ligar(c, 'historicoFuncionarios', false); // exceção individual negando a leitura que o grupo dá
      await ligar(c, TOGGLE, true);
      assert.equal((await efetivas(c)).recursos.employeeHistory.visualizar, false);
      assert.deepEqual(await avaliar(c, 'USUARIO'), { visualizar: false, exportar: true, permitido: false });
    });
  });

  describe('JI4 — MASTER', () => {
    test('JI4.1 MASTER provisionado: toggle ligado e fixo; /auth/permissoes e autorização final concedem; não é configurável', async () => {
      const t = await toggleDe(master, TOGGLE);
      assert.ok(t, 'toggle ausente para o MASTER');
      assert.deepEqual([t.ligado, t.fixo], [true, true]);
      assert.equal(await exportarEfetivo(master), true);
      assert.deepEqual(await avaliar(master, 'MASTER'), { visualizar: true, exportar: true, permitido: true });
      const r = await g.request(g.app).put(`/api/administracao/usuarios/${master.usuarioId}/acessos/${TOGGLE}`).set('Cookie', g.cookie(master)).send({ ligado: false });
      assert.deepEqual([r.status, r.body.codigo], [409, 'USUARIO_MASTER_PERMISSOES_FIXAS']);
    });

    test('JI4.2 só o MASTER grava as camadas individuais: ADMINISTRADOR autorizado não liga exportar para ninguém', async () => {
      const admin = await g.administradorAutorizado(g.empresas.A, master);
      const alvo = await novaConta();
      const r = await g.request(g.app).put(`/api/administracao/usuarios/${alvo.usuarioId}/acessos/${TOGGLE}`).set('Cookie', g.cookie(admin)).send({ ligado: true });
      assert.equal(r.status, 403, JSON.stringify(r.body));
      assert.equal(await exportarEfetivo(alvo), false);
    });
  });

  describe('JI5 — isolamento e ausência de dados', () => {
    test('JI5.1 outra empresa: a concessão da empresa A não vale na B; o MASTER de A não configura usuário de B', async () => {
      const c = await novaConta();
      await ligar(c, 'historicoFuncionarios', true);
      await ligar(c, TOGGLE, true);
      assert.deepEqual(await avaliar({ empresaId: g.empresas.B, usuarioId: c.usuarioId }, 'USUARIO'), { visualizar: false, exportar: false, permitido: false });
      const deB = await novaConta('USUARIO', g.empresas.B);
      const r = await g.request(g.app).put(`/api/administracao/usuarios/${deB.usuarioId}/acessos/${TOGGLE}`).set('Cookie', g.cookie(master)).send({ ligado: true });
      assert.equal(r.status, 404);
    });

    test('JI5.2 as respostas só trazem booleanos de permissão: nenhum dado de funcionário, arquivo ou link', async () => {
      const c = await novaConta();
      await ligar(c, 'historicoFuncionarios', true);
      const put = await ligar(c, TOGGLE, true);
      const corpo = await efetivas(c);
      assert.equal(typeof corpo.acoes[CODIGO], 'boolean');
      const texto = JSON.stringify([put, corpo]);
      for (const proibido of ['cpf', 'matricula', 'arquivo', 'download', 'url', '.csv', '.xlsx', '.pdf']) assert.equal(texto.toLowerCase().includes(proibido), false, proibido);
      assert.deepEqual(Object.keys(put.acesso).sort(), ['fixo', 'grupo', 'id', 'ligado', 'rotulo']);
    });
  });
});
