'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteGhe } = require('./helpers/ambiente-funcionario-ghe');
const { cpfFicticio } = require('../helpers/cpf-ficticio');

/**
 * Histórico de Funcionários — pacote G (RED): histórico de ALTERAÇÕES CADASTRAIS.
 *
 * Mesmo endpoint e envelope dos pacotes E e F: GET /api/funcionarios/:id/eventos?tipo=CADASTRAL&pagina=&limite=
 * (employeeHistory.visualizar). Cada evento é UM registro de auditoria:
 *   { id, tipo: CADASTRO | IMPORTACAO | ALTERACAO, ocorridoEm, alteracoes: [{ campo, anterior, novo }], responsavel }
 * Fontes reais (código atual e histórico do Git):
 *   - FUNCIONARIO_ALTERADO grava o instantâneo ANTES e DEPOIS (matricula, nome, grupoHomogeneoId, setor, funcao, cracha,
 *     dataAdmissao — esta só desde 536fd49 —, ativo). O PATCH grava o evento sempre que um campo é INFORMADO, mesmo sem
 *     mudança: a alteração real é só o campo cujo valor antes ≠ depois. Evento sem nenhuma diferença nos campos do
 *     histórico cadastral não aparece. Campo ausente num dos lados (registro antigo) não é comparado nem inventado.
 *   - FUNCIONARIO_CRIADO (cadastro e importação): registro inicial; `alteracoes` com os valores iniciais não nulos
 *     (anterior null).
 * Campos fixados por este RED: nome, matricula, setor, funcao (nessa ordem). GHE é o pacote E, situação/ativo é o F.
 * Nunca: CPF, telefone, nascimento (só o NOME do campo é auditado, e como "informado", não "alterado"), contexto, ip,
 * dispositivo, JSON bruto. Crachá e data de admissão dependem de decisão (fora das expectativas deste RED).
 */

describe('G — histórico de alterações cadastrais (PostgreSQL real)', () => {
  let amb;
  let nomeMaster;
  const ids = {};

  const eventosDe = (usuarioId, id, q = 'tipo=CADASTRAL&pagina=1&limite=20') => amb.como(usuarioId).get(`/api/funcionarios/${id}/eventos?${q}`);
  async function lerEventos(id, q) {
    const r = await eventosDe(amb.usuarios.soVisualizar, id, q);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.eventos), JSON.stringify(r.body));
    return r.body;
  }
  const auditar = (v) => amb.pool.query(
    `INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, ip, dispositivo, contexto, dados_anteriores, dados_novos, criado_em)
     VALUES ($1, $2, $3, $4, '203.0.113.99', 'Navegador legado G', $5, $6, $7, $8)`,
    [v.empresaId ?? amb.d.empresaA, v.usuarioId === undefined ? amb.usuarios.master : v.usuarioId, v.acao, String(v.referencia),
      v.contexto ?? null, v.anteriores ?? null, v.novos ?? null, v.em],
  );
  const inst = (extra = {}) => ({ matricula: 'LEG-G', nome: 'Pessoa Legada G', grupoHomogeneoId: null, setor: 'Setor G', funcao: 'Função G', cracha: null, ativo: true, ...extra });
  const patch = async (id, corpo) => {
    const r = await amb.como(amb.usuarios.master).patch(`/api/funcionarios/${id}`, corpo);
    assert.equal(r.status, 200, `${JSON.stringify(corpo)}: ${JSON.stringify(r.body)}`);
  };
  const resumo = (eventos) => eventos.map((e) => [e.tipo, e.alteracoes.map((a) => [a.campo, a.anterior, a.novo])]);
  const campos = (e) => e.alteracoes.map((a) => a.campo);

  before(async () => {
    amb = await montarAmbienteGhe();
    nomeMaster = (await amb.pool.query('SELECT nome FROM usuarios WHERE id = $1', [amb.usuarios.master])).rows[0].nome;

    // Atual pelas rotas reais.
    const criado = await amb.como(amb.usuarios.master).post('/api/funcionarios', {
      nome: 'Pessoa G', cpf: cpfFicticio(9300), matricula: 'G-001', grupoHomogeneoId: amb.ghes.soldagem,
      setor: 'Produção', funcao: 'Operador', telefone: '47999990001', dataNascimento: '1990-01-01', dataAdmissao: '2026-01-05',
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    ids.atual = criado.body.funcionario.id;
    const A = ids.atual;
    await patch(A, { nome: 'Pessoa G Silva' });                 // muda nome
    await patch(A, { matricula: 'G-002' });                     // muda matrícula
    await patch(A, { setor: 'Manutenção', funcao: 'Mecânico' }); // muda dois campos de uma vez
    await patch(A, { setor: 'Manutenção' });                    // informado SEM mudança
    await patch(A, { telefone: '47999990002' });                // só campo sensível: nada cadastral muda
    await patch(A, { grupoHomogeneoId: amb.ghes.caldeiraria }); // só GHE: é o pacote E
    const sit = await amb.como(amb.usuarios.master).post(`/api/funcionarios/${A}/situacao`, { situacao: 'AFASTADO' }); // pacote F
    assert.equal(sit.status, 200, JSON.stringify(sit.body));
    assert.deepEqual(await amb.eventos(A), [
      'FUNCIONARIO_CRIADO', 'FUNCIONARIO_ALTERADO', 'FUNCIONARIO_ALTERADO', 'FUNCIONARIO_ALTERADO', 'FUNCIONARIO_ALTERADO',
      'FUNCIONARIO_ALTERADO', 'FUNCIONARIO_ALTERADO', 'FUNCIONARIO_GHE_ALTERADO', 'FUNCIONARIO_SITUACAO_ALTERADA',
    ], 'os eventos reais gravados pelos serviços (pré-condição das fixtures)');

    ids.semEventos = await amb.trabalhadorNoGhe(amb.ghes.soldagem);

    // Legado: registro sem a chave `setor` num dos lados e sem usuário; cadastro antigo sem matrícula.
    ids.legado = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    const L = ids.legado;
    await auditar({ acao: 'FUNCIONARIO_CRIADO', referencia: L, em: '2025-01-10T12:00:00Z', contexto: { criadoPor: amb.usuarios.master }, novos: inst({ matricula: null }) });
    const semSetor = inst({ nome: 'Pessoa Legada G2' });
    delete semSetor.setor;
    await auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia: L, usuarioId: null, em: '2025-03-10T12:00:00Z', anteriores: inst(), novos: semSetor });

    ids.importado = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    await auditar({ acao: 'FUNCIONARIO_CRIADO', referencia: ids.importado, em: '2026-05-02T13:00:00Z',
      contexto: { criadoPor: amb.usuarios.master, origem: 'importacao', importacaoId: 'imp-g-1', linha: 4 }, novos: inst({ matricula: 'IMP-1', nome: 'Pessoa Importada' }) });

    // Muitos eventos para a paginação: cinco mudanças de setor.
    ids.paginado = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    for (let k = 1; k <= 5; k += 1) {
      await auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia: ids.paginado, em: `2026-03-0${k}T12:00:00Z`,
        anteriores: inst({ setor: `S${k - 1}` }), novos: inst({ setor: `S${k}` }) });
    }

    // Mesma referência em outra empresa e em outra ação: nunca entram.
    await auditar({ empresaId: amb.d.empresaB, usuarioId: amb.usuarios.masterB, acao: 'FUNCIONARIO_ALTERADO', referencia: A, em: '2026-06-01T12:00:00Z', anteriores: inst({ nome: 'Outra Empresa A' }), novos: inst({ nome: 'Outra Empresa B' }) });
    await auditar({ acao: 'MATERIAL_ALTERADO', referencia: A, em: '2026-06-02T12:00:00Z', anteriores: { nome: 'Material X' }, novos: { nome: 'Material Y' } });
  });
  after(async () => { if (amb) await amb.encerrar(); });

  describe('G1 — eventos atuais pelas rotas reais', () => {
    test('G1.1 só as alterações REAIS de nome, matrícula, setor e função, mais o cadastro; mais recente primeiro', async () => {
      const corpo = await lerEventos(ids.atual);
      assert.deepEqual([corpo.status, corpo.funcionarioId, corpo.tipo, corpo.total, corpo.pagina, corpo.limite], ['ok', ids.atual, 'CADASTRAL', 4, 1, 20]);
      assert.deepEqual(resumo(corpo.eventos).slice(0, 3), [
        ['ALTERACAO', [['setor', 'Produção', 'Manutenção'], ['funcao', 'Operador', 'Mecânico']]],
        ['ALTERACAO', [['matricula', 'G-001', 'G-002']]],
        ['ALTERACAO', [['nome', 'Pessoa G', 'Pessoa G Silva']]],
      ]);
    });

    test('G1.2 cadastro inicial: tipo CADASTRO, valores iniciais com anterior null (nome, matrícula, setor, função)', async () => {
      const { eventos } = await lerEventos(ids.atual);
      const inicial = eventos.at(-1);
      assert.equal(inicial.tipo, 'CADASTRO');
      const porCampo = Object.fromEntries(inicial.alteracoes.map((a) => [a.campo, [a.anterior, a.novo]]));
      assert.deepEqual([porCampo.nome, porCampo.matricula, porCampo.setor, porCampo.funcao], [[null, 'Pessoa G'], [null, 'G-001'], [null, 'Produção'], [null, 'Operador']]);
    });

    test('G1.3 PATCH sem mudança efetiva, só de telefone, só de GHE e mudança de situação NÃO viram evento cadastral', async () => {
      const { eventos, total } = await lerEventos(ids.atual);
      assert.equal(total, 4);
      for (const e of eventos) {
        for (const c of campos(e)) assert.ok(['nome', 'matricula', 'setor', 'funcao', 'cracha', 'dataAdmissao'].includes(c), `campo inesperado: ${c}`);
      }
    });

    test('G1.4 cada evento: id, tipo, ocorridoEm (decrescente), alteracoes e responsável { id, nome } — e nada além', async () => {
      const { eventos } = await lerEventos(ids.atual);
      for (const e of eventos) {
        assert.deepEqual(Object.keys(e).sort(), ['alteracoes', 'id', 'ocorridoEm', 'responsavel', 'tipo']);
        assert.equal(typeof e.id, 'string');
        assert.deepEqual(e.responsavel, { id: amb.usuarios.master, nome: nomeMaster });
        for (const a of e.alteracoes) assert.deepEqual(Object.keys(a).sort(), ['anterior', 'campo', 'novo']);
      }
      const t = eventos.map((e) => Date.parse(e.ocorridoEm));
      assert.deepEqual(t, [...t].sort((a, b) => b - a));
    });

    test('G1.5 GHE e situação continuam nos seus tipos (separados)', async () => {
      const ghe = await eventosDe(amb.usuarios.soVisualizar, ids.atual, 'tipo=GHE&pagina=1&limite=20');
      const sit = await eventosDe(amb.usuarios.soVisualizar, ids.atual, 'tipo=SITUACAO&pagina=1&limite=20');
      assert.deepEqual([ghe.status, ghe.body.total, sit.status, sit.body.total], [200, 2, 200, 2]);
    });
  });

  describe('G2 — legados, importação e informação parcial', () => {
    test('G2.1 campo ausente num dos lados não é comparado; sem usuário = null; cadastro antigo sem matrícula não a inventa', async () => {
      const { eventos } = await lerEventos(ids.legado);
      assert.deepEqual(resumo(eventos), [
        ['ALTERACAO', [['nome', 'Pessoa Legada G', 'Pessoa Legada G2']]],
        ['CADASTRO', [['nome', null, 'Pessoa Legada G'], ['setor', null, 'Setor G'], ['funcao', null, 'Função G']]],
      ]);
      assert.equal(eventos[0].responsavel, null);
    });

    test('G2.2 importação com evento individual: tipo IMPORTACAO com os valores iniciais', async () => {
      const { eventos } = await lerEventos(ids.importado);
      assert.deepEqual(resumo(eventos), [['IMPORTACAO', [['nome', null, 'Pessoa Importada'], ['matricula', null, 'IMP-1'], ['setor', null, 'Setor G'], ['funcao', null, 'Função G']]]]);
    });

    test('G2.3 funcionário sem eventos: lista vazia, total 0', async () => {
      const corpo = await lerEventos(ids.semEventos);
      assert.deepEqual([corpo.eventos, corpo.total], [[], 0]);
    });
  });

  describe('G3 — paginação e parâmetros', () => {
    test('G3.1 limite 2: páginas 2 + 2 + 1, total 5, sem repetir nem perder', async () => {
      const p = [];
      for (const pagina of [1, 2, 3]) p.push(await lerEventos(ids.paginado, `tipo=CADASTRAL&pagina=${pagina}&limite=2`));
      assert.deepEqual(p.map((x) => [x.eventos.length, x.total]), [[2, 5], [2, 5], [1, 5]]);
      assert.deepEqual(p.flatMap((x) => x.eventos.map((e) => e.alteracoes[0].novo)), ['S5', 'S4', 'S3', 'S2', 'S1']);
    });

    test('G3.2 tipo CADASTRAL aceito; GHE e SITUACAO continuam; tipo desconhecido, limite > 100 e campo extra → 400', async () => {
      for (const tipo of ['CADASTRAL', 'GHE', 'SITUACAO']) assert.equal((await eventosDe(amb.usuarios.soVisualizar, ids.atual, `tipo=${tipo}&pagina=1&limite=20`)).status, 200, tipo);
      for (const q of ['tipo=OUTRO&pagina=1&limite=20', 'tipo=CADASTRAL&pagina=1&limite=101', 'tipo=CADASTRAL&pagina=1&limite=20&empresaId=2']) {
        assert.equal((await eventosDe(amb.usuarios.soVisualizar, ids.atual, q)).status, 400, q);
      }
    });
  });

  describe('G4 — segurança', () => {
    test('G4.1 só employeeHistory.visualizar basta; sem a permissão 403; sem sessão 401', async () => {
      assert.equal((await eventosDe(amb.usuarios.soVisualizar, ids.atual)).status, 200);
      assert.equal((await eventosDe(amb.usuarios.semPermissao, ids.atual)).status, 403);
      const anonimo = await require('supertest')(amb.app).get(`/api/funcionarios/${ids.atual}/eventos?tipo=CADASTRAL&pagina=1&limite=20`);
      assert.equal(anonimo.status, 401);
    });

    test('G4.2 inexistente e de outra empresa: o mesmo 404 FUNCIONARIO_NAO_ENCONTRADO', async () => {
      const inexistente = await eventosDe(amb.usuarios.soVisualizar, 999999);
      const outraEmpresa = await eventosDe(amb.usuarios.masterB, ids.atual);
      assert.deepEqual([inexistente.status, inexistente.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
      assert.deepEqual([outraEmpresa.status, outraEmpresa.body], [inexistente.status, inexistente.body]);
    });

    test('G4.3 nada de outra empresa, de outra ação nem dado sensível ou interno (CPF, telefone, nascimento, ip, contexto)', async () => {
      for (const id of [ids.atual, ids.legado, ids.importado]) {
        const corpo = await lerEventos(id);
        assert.ok(corpo.eventos.length > 0);
        const texto = JSON.stringify(corpo);
        for (const proibido of ['cpf', cpfFicticio(9300), '47999990001', '47999990002', 'telefone', 'dataNascimento', '1990-01-01', 'contexto', 'dadosAnteriores',
          'dados_anteriores', 'acao', 'referencia', '203.0.113', 'dispositivo', 'Navegador', 'perfil', 'importacaoId', 'imp-g-1', 'camposSensiveis',
          'criadoPor', 'grupoHomogeneo', 'ativo', 'Outra Empresa', 'Material']) {
          assert.equal(texto.includes(proibido), false, `funcionário ${id}: contém ${proibido}`);
        }
      }
    });
  });
});
