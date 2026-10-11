'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteGhe } = require('./helpers/ambiente-funcionario-ghe');
const { cpfFicticio } = require('../helpers/cpf-ficticio');

/**
 * Histórico de Funcionários — pacote F (RED): histórico de SITUAÇÃO do funcionário.
 *
 * Mesmo endpoint e envelope do pacote E: GET /api/funcionarios/:id/eventos?tipo=SITUACAO&pagina=&limite=
 * (employeeHistory.visualizar; sem reportsAudit). Cada evento: { id, tipo, ocorridoEm, anterior, novo, responsavel }, com
 * anterior/novo = 'ATIVO' | 'AFASTADO' | 'INATIVO' | null. Fontes reais (confirmadas no código e no histórico do Git):
 *   - FUNCIONARIO_SITUACAO_ALTERADA (desde o S2): { situacao } anterior e nova, com AFASTADO;
 *   - FUNCIONARIO_INATIVADO / FUNCIONARIO_REATIVADO: desde o Bloco 9; ANTES do S2 eram o único registro (ATIVO ↔ INATIVO,
 *     lido do campo `ativo` do instantâneo). Desde o S2 são gravados DEPOIS do SITUACAO_ALTERADA na mesma transação: o
 *     legado só sai quando fecha a correlação inteira com ele (empresa, referência, instante, usuário, id menor do
 *     SITUACAO_ALTERADA e a MESMA transição) — a mesma regra de deduplicação do pacote E;
 *   - FUNCIONARIO_CRIADO com a chave `ativo` (cadastro e importação): situação inicial; sem a chave, não é inventada;
 *   - FUNCIONARIO_ALTERADO nunca mudou a situação (o PATCH jamais aceitou ativo/situacao): não é fonte.
 * Ordem criado_em DESC, id DESC; paginação real; nunca JSON bruto, contexto, ip, dispositivo, instantâneo, CPF.
 */

describe('F — histórico de situação do funcionário (PostgreSQL real)', () => {
  let amb;
  let nomeMaster;
  const ids = {};
  let seq = 0;

  const eventosDe = (usuarioId, id, q = 'tipo=SITUACAO&pagina=1&limite=20') => amb.como(usuarioId).get(`/api/funcionarios/${id}/eventos?${q}`);
  async function lerEventos(id, q) {
    const r = await eventosDe(amb.usuarios.soVisualizar, id, q);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.eventos), JSON.stringify(r.body));
    return r.body;
  }
  const auditar = (v) => amb.pool.query(
    `INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, ip, dispositivo, contexto, dados_anteriores, dados_novos, criado_em)
     VALUES ($1, $2, $3, $4, '203.0.113.88', 'Navegador legado F', $5, $6, $7, $8)`,
    [v.empresaId ?? amb.d.empresaA, v.usuarioId === undefined ? amb.usuarios.master : v.usuarioId, v.acao, String(v.referencia),
      v.contexto ?? null, v.anteriores ?? null, v.novos ?? null, v.em],
  );
  const inst = (ativo, extra = {}) => ({ matricula: 'LEG-F', nome: 'Pessoa Legada F', grupoHomogeneoId: null, setor: 'Setor F', funcao: 'Função F', cracha: null, dataAdmissao: null, ativo, ...extra });
  const sit = (s) => ({ situacao: s });
  const post = async (url, corpo) => {
    const r = await amb.como(amb.usuarios.master).post(url, corpo);
    assert.equal(r.status, 200, `${url}: ${JSON.stringify(r.body)}`);
  };

  before(async () => {
    amb = await montarAmbienteGhe();
    nomeMaster = (await amb.pool.query('SELECT nome FROM usuarios WHERE id = $1', [amb.usuarios.master])).rows[0].nome;

    // Atual: cadastro (ATIVO) → AFASTADO → ATIVO (rota nova) → INATIVO (rota legada inativar) → ATIVO (rota legada reativar).
    seq += 1;
    const criado = await amb.como(amb.usuarios.master).post('/api/funcionarios', {
      nome: 'Pessoa F', cpf: cpfFicticio(8900 + seq), grupoHomogeneoId: amb.ghes.soldagem, setor: 'Produção', funcao: 'Operador', dataAdmissao: '2026-01-05',
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    ids.atual = criado.body.funcionario.id;
    const A = ids.atual;
    await post(`/api/funcionarios/${A}/situacao`, { situacao: 'AFASTADO' });
    await post(`/api/funcionarios/${A}/situacao`, { situacao: 'ATIVO' });
    await post(`/api/funcionarios/${A}/inativar`, {});
    await post(`/api/funcionarios/${A}/reativar`, {});
    // Eventos do mesmo funcionário que NÃO são de situação: GHE, setor e CPF consultado.
    const ghe = await amb.como(amb.usuarios.master).patch(`/api/funcionarios/${A}`, { grupoHomogeneoId: amb.ghes.caldeiraria, setor: 'Manutenção' });
    assert.equal(ghe.status, 200, JSON.stringify(ghe.body));
    await post(`/api/funcionarios/${A}/cpf/revelar`, {});
    assert.deepEqual(await amb.eventos(A), [
      'FUNCIONARIO_CRIADO', 'FUNCIONARIO_SITUACAO_ALTERADA', 'FUNCIONARIO_SITUACAO_ALTERADA',
      'FUNCIONARIO_SITUACAO_ALTERADA', 'FUNCIONARIO_INATIVADO', 'FUNCIONARIO_SITUACAO_ALTERADA', 'FUNCIONARIO_REATIVADO',
      'FUNCIONARIO_ALTERADO', 'FUNCIONARIO_GHE_ALTERADO', 'FUNCIONARIO_CPF_CONSULTADO',
    ], 'os eventos reais gravados pelos serviços (pré-condição das fixtures)');

    ids.semEventos = await amb.trabalhadorNoGhe(amb.ghes.soldagem);

    // Legado (antes do S2): cadastro, inativação e reativação só com o instantâneo; cadastro sem a chave `ativo`; sem usuário.
    ids.legado = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    const L = ids.legado;
    await auditar({ acao: 'FUNCIONARIO_CRIADO', referencia: L, em: '2025-01-10T12:00:00Z', contexto: { criadoPor: amb.usuarios.master }, novos: inst(true) });
    await auditar({ acao: 'FUNCIONARIO_INATIVADO', referencia: L, em: '2025-03-10T12:00:00Z', anteriores: inst(true), novos: inst(false) });
    await auditar({ acao: 'FUNCIONARIO_REATIVADO', referencia: L, usuarioId: null, em: '2025-05-10T12:00:00Z', anteriores: inst(false), novos: inst(true) });
    await auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia: L, em: '2025-06-10T12:00:00Z', anteriores: inst(true), novos: inst(true, { setor: 'Outro' }) });

    ids.semChave = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    await auditar({ acao: 'FUNCIONARIO_CRIADO', referencia: ids.semChave, em: '2024-12-01T12:00:00Z', novos: { matricula: 'OLD', nome: 'Antigo' } });

    ids.importado = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    await auditar({ acao: 'FUNCIONARIO_CRIADO', referencia: ids.importado, em: '2026-05-02T13:00:00Z',
      contexto: { criadoPor: amb.usuarios.master, origem: 'importacao', importacaoId: 'imp-f-1', linha: 3 }, novos: inst(true) });

    // Deduplicação segura: some só o legado que fecha a correlação inteira com o SITUACAO_ALTERADA.
    ids.dedupe = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    const D = ids.dedupe;
    // mesmo instante, usuário DIFERENTE → dois eventos
    await auditar({ acao: 'FUNCIONARIO_SITUACAO_ALTERADA', referencia: D, em: '2026-02-01T10:00:00Z', anteriores: sit('ATIVO'), novos: sit('INATIVO') });
    await auditar({ acao: 'FUNCIONARIO_INATIVADO', referencia: D, usuarioId: amb.usuarios.comEditar, em: '2026-02-01T10:00:00Z', anteriores: inst(true), novos: inst(false) });
    // mesmo instante e usuário, transição DIFERENTE → dois eventos
    await auditar({ acao: 'FUNCIONARIO_SITUACAO_ALTERADA', referencia: D, em: '2026-02-02T10:00:00Z', anteriores: sit('INATIVO'), novos: sit('AFASTADO') });
    await auditar({ acao: 'FUNCIONARIO_REATIVADO', referencia: D, em: '2026-02-02T10:00:00Z', anteriores: inst(false), novos: inst(true) });
    // correlação completa (instante, usuário, gravado depois, mesma transição) → um evento só
    await auditar({ acao: 'FUNCIONARIO_SITUACAO_ALTERADA', referencia: D, em: '2026-02-03T10:00:00Z', anteriores: sit('AFASTADO'), novos: sit('ATIVO') });
    await auditar({ acao: 'FUNCIONARIO_SITUACAO_ALTERADA', referencia: D, em: '2026-02-04T10:00:00Z', anteriores: sit('ATIVO'), novos: sit('INATIVO') });
    await auditar({ acao: 'FUNCIONARIO_INATIVADO', referencia: D, em: '2026-02-04T10:00:00Z', anteriores: inst(true), novos: inst(false) });

    // Mesma referência em outra empresa e em outra ação: nunca entram.
    await auditar({ empresaId: amb.d.empresaB, usuarioId: amb.usuarios.masterB, acao: 'FUNCIONARIO_SITUACAO_ALTERADA', referencia: A, em: '2026-06-01T12:00:00Z', anteriores: sit('ATIVO'), novos: sit('AFASTADO') });
    await auditar({ acao: 'MATERIAL_INATIVADO', referencia: A, em: '2026-06-02T12:00:00Z', anteriores: { ativo: true }, novos: { ativo: false } });
  });
  after(async () => { if (amb) await amb.encerrar(); });

  const transicoes = (eventos) => eventos.map((e) => [e.tipo, e.anterior, e.novo]);

  describe('F1 — eventos atuais pelas rotas reais', () => {
    test('F1.1 cadastro + quatro mudanças: 5 eventos, mais recente primeiro; cada inativar/reativar conta UMA vez', async () => {
      const corpo = await lerEventos(ids.atual);
      assert.deepEqual([corpo.status, corpo.funcionarioId, corpo.tipo, corpo.total, corpo.pagina, corpo.limite], ['ok', ids.atual, 'SITUACAO', 5, 1, 20]);
      assert.deepEqual(transicoes(corpo.eventos), [
        ['ALTERACAO', 'INATIVO', 'ATIVO'], ['ALTERACAO', 'ATIVO', 'INATIVO'], ['ALTERACAO', 'AFASTADO', 'ATIVO'], ['ALTERACAO', 'ATIVO', 'AFASTADO'], ['CADASTRO', null, 'ATIVO'],
      ]);
    });

    test('F1.2 cada evento: id, tipo, ocorridoEm (decrescente) e responsável { id, nome } — e nada além', async () => {
      const { eventos } = await lerEventos(ids.atual);
      for (const e of eventos) {
        assert.deepEqual(Object.keys(e).sort(), ['anterior', 'id', 'novo', 'ocorridoEm', 'responsavel', 'tipo']);
        assert.equal(typeof e.id, 'string');
        assert.deepEqual(e.responsavel, { id: amb.usuarios.master, nome: nomeMaster });
      }
      const t = eventos.map((e) => Date.parse(e.ocorridoEm));
      assert.deepEqual(t, [...t].sort((a, b) => b - a));
    });

    test('F1.3 o histórico de GHE do mesmo funcionário continua só com GHE (tipos separados)', async () => {
      const r = await eventosDe(amb.usuarios.soVisualizar, ids.atual, 'tipo=GHE&pagina=1&limite=20');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.eventos.map((e) => e.tipo), ['ALTERACAO', 'CADASTRO']);
      assert.equal(JSON.stringify(r.body).includes('AFASTADO'), false);
    });
  });

  describe('F2 — legados, importação e informação parcial', () => {
    test('F2.1 antes do S2: cadastro, inativação e reativação lidos do instantâneo (ATIVO ↔ INATIVO); ALTERADO sem mudança não entra; sem usuário = null', async () => {
      const { eventos } = await lerEventos(ids.legado);
      assert.deepEqual(transicoes(eventos), [['ALTERACAO', 'INATIVO', 'ATIVO'], ['ALTERACAO', 'ATIVO', 'INATIVO'], ['CADASTRO', null, 'ATIVO']]);
      assert.equal(eventos[0].responsavel, null);
      assert.deepEqual(eventos[1].responsavel, { id: amb.usuarios.master, nome: nomeMaster });
    });

    test('F2.2 cadastro sem a chave `ativo` não é inventado; sem nenhum evento = lista vazia (resposta válida)', async () => {
      for (const id of [ids.semChave, ids.semEventos]) {
        const corpo = await lerEventos(id);
        assert.deepEqual([corpo.eventos, corpo.total], [[], 0], String(id));
      }
    });

    test('F2.3 importação com evento individual: tipo IMPORTACAO, situação inicial ATIVO', async () => {
      assert.deepEqual(transicoes((await lerEventos(ids.importado)).eventos), [['IMPORTACAO', null, 'ATIVO']]);
    });
  });

  describe('F3 — deduplicação segura', () => {
    test('F3.1 some só o legado que fecha a correlação inteira; usuário ou transição diferentes no mesmo instante continuam', async () => {
      const { eventos, total } = await lerEventos(ids.dedupe);
      assert.equal(total, 6, JSON.stringify(transicoes(eventos)));
      const dia = (d) => eventos.filter((e) => e.ocorridoEm.startsWith(d)).map((e) => [e.anterior, e.novo]);
      assert.deepEqual(dia('2026-02-04'), [['ATIVO', 'INATIVO']], 'par correlacionado: um evento');
      assert.deepEqual(dia('2026-02-03'), [['AFASTADO', 'ATIVO']]);
      assert.deepEqual(dia('2026-02-02'), [['INATIVO', 'ATIVO'], ['INATIVO', 'AFASTADO']], 'transição diferente: os dois (o legado, gravado depois, primeiro)');
      assert.equal(dia('2026-02-01').length, 2, 'usuário diferente: os dois');
    });
  });

  describe('F4 — paginação e parâmetros', () => {
    test('F4.1 limite 2: páginas 2 + 2 + 1, total 5, sem repetir nem perder', async () => {
      const p = [];
      for (const pagina of [1, 2, 3]) p.push(await lerEventos(ids.atual, `tipo=SITUACAO&pagina=${pagina}&limite=2`));
      assert.deepEqual(p.map((x) => [x.eventos.length, x.total]), [[2, 5], [2, 5], [1, 5]]);
      const todos = (await lerEventos(ids.atual)).eventos.map((e) => e.id);
      assert.deepEqual(p.flatMap((x) => x.eventos.map((e) => e.id)), todos);
    });

    test('F4.2 tipo SITUACAO aceito; tipo desconhecido, limite > 100, página 0 e campo extra → 400', async () => {
      assert.equal((await eventosDe(amb.usuarios.soVisualizar, ids.atual)).status, 200);
      for (const q of ['tipo=CADASTRO&pagina=1&limite=20', 'tipo=SITUACAO&pagina=1&limite=101', 'tipo=SITUACAO&pagina=0&limite=20', 'tipo=SITUACAO&pagina=1&limite=20&empresaId=2']) {
        assert.equal((await eventosDe(amb.usuarios.soVisualizar, ids.atual, q)).status, 400, q);
      }
    });
  });

  describe('F5 — segurança', () => {
    test('F5.1 só employeeHistory.visualizar basta; sem a permissão 403; sem sessão 401', async () => {
      assert.equal((await eventosDe(amb.usuarios.soVisualizar, ids.atual)).status, 200);
      assert.equal((await eventosDe(amb.usuarios.semPermissao, ids.atual)).status, 403);
      const anonimo = await require('supertest')(amb.app).get(`/api/funcionarios/${ids.atual}/eventos?tipo=SITUACAO&pagina=1&limite=20`);
      assert.equal(anonimo.status, 401);
    });

    test('F5.2 inexistente e de outra empresa: o mesmo 404 FUNCIONARIO_NAO_ENCONTRADO', async () => {
      const inexistente = await eventosDe(amb.usuarios.soVisualizar, 999999);
      const outraEmpresa = await eventosDe(amb.usuarios.masterB, ids.atual);
      assert.deepEqual([inexistente.status, inexistente.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
      assert.deepEqual([outraEmpresa.status, outraEmpresa.body], [inexistente.status, inexistente.body]);
    });

    test('F5.3 nada de outra empresa, de outra ação nem dado sensível ou interno', async () => {
      for (const id of [ids.atual, ids.legado, ids.importado]) {
        const corpo = await lerEventos(id);
        assert.ok(corpo.eventos.length > 0);
        const texto = JSON.stringify(corpo);
        for (const proibido of ['contexto', 'dadosAnteriores', 'dados_anteriores', 'acao', 'referencia', '203.0.113', 'dispositivo', 'Navegador',
          'perfil', 'cpf', 'matricula', 'setor', 'funcao', 'importacaoId', 'imp-f-1', 'camposSensiveis', 'criadoPor', 'GESTAO_FUNCIONARIOS', 'grupoHomogeneo']) {
          assert.equal(texto.includes(proibido), false, `funcionário ${id}: contém ${proibido}`);
        }
      }
      assert.equal((await lerEventos(ids.atual)).total, 5, 'nem outra empresa nem MATERIAL_INATIVADO com a mesma referência');
    });
  });
});
