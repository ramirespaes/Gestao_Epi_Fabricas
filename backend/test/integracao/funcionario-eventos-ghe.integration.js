'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteGhe } = require('./helpers/ambiente-funcionario-ghe');
const { cpfFicticio } = require('../helpers/cpf-ficticio');

/**
 * Histórico de Funcionários — pacote E (RED): histórico de GHE do funcionário.
 *
 * Contrato proposto: GET /api/funcionarios/:id/eventos?tipo=GHE&pagina=&limite= (employeeHistory.visualizar; sem
 * reportsAudit). Lê SÓ logs_auditoria da empresa da sessão, com referencia = id do funcionário, e devolve eventos
 * sanitizados, do mais recente ao mais antigo (criado_em DESC, id DESC), paginados:
 *   { status, funcionarioId, tipo: 'GHE', eventos: [{ id, tipo, ocorridoEm, anterior, novo, responsavel }], total, pagina, limite }
 *   tipo: 'CADASTRO' | 'IMPORTACAO' (registro inicial, de FUNCIONARIO_CRIADO com grupoHomogeneoId) | 'ALTERACAO'
 *   anterior/novo: { id, codigo, descricao } ou null (sem GHE). codigo/descricao só quando o evento os gravou
 *     (FUNCIONARIO_GHE_ALTERADO, desde o S3); FUNCIONARIO_CRIADO e o FUNCIONARIO_ALTERADO legado gravam só o id →
 *     codigo e descricao null (nunca o nome ATUAL do GHE apresentado como histórico).
 *   responsavel: { id, nome } do usuário da empresa que agiu, ou null.
 * Fontes: FUNCIONARIO_GHE_ALTERADO; FUNCIONARIO_ALTERADO com grupoHomogeneoId diferente SÓ quando não há
 * FUNCIONARIO_GHE_ALTERADO no mesmo instante (mesma transação) — o par do S3 conta uma vez; FUNCIONARIO_CRIADO com a
 * chave grupoHomogeneoId (cadastro e importação). Evento sem a chave (anterior ao GHE) não é inventado.
 * Nunca: JSON bruto, contexto, ip, dispositivo, perfil, CPF, telefone, nascimento, instantâneo do cadastro, outros
 * eventos (situação, CPF consultado) ou eventos de outra empresa.
 */

describe('E — histórico de GHE do funcionário (PostgreSQL real)', () => {
  let amb;
  let nomeMaster;
  const ids = {};
  let seq = 0;

  const get = (usuarioId, url) => amb.como(usuarioId).get(url);
  const eventosDe = (usuarioId, id, q = 'tipo=GHE&pagina=1&limite=20') => get(usuarioId, `/api/funcionarios/${id}/eventos?${q}`);
  /** Corpo de uma consulta que TEM de dar 200 com lista de eventos (falha por asserção, nunca por TypeError). */
  async function lerEventos(id, q) {
    const r = await eventosDe(amb.usuarios.soVisualizar, id, q);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.eventos), JSON.stringify(r.body));
    return r.body;
  }
  const ghe = (id, codigo, descricao) => ({ id, codigo, descricao });
  // GREEN E (decisão aprovada): GHE gravado só pelo id → histórico nulo + `atual` com a identificação ATUAL na empresa.
  const soId = (id, atual) => ({ id, codigo: null, descricao: null, atual });
  /** Grava uma linha de auditoria no formato que o sistema gravava (eventos legados), com instante explícito. */
  const auditar = (valores) => amb.pool.query(
    `INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, ip, dispositivo, contexto, dados_anteriores, dados_novos, criado_em)
     VALUES ($1, $2, $3, $4, '203.0.113.77', 'Navegador legado', $5, $6, $7, $8)`,
    [valores.empresaId ?? amb.d.empresaA, valores.usuarioId === undefined ? amb.usuarios.master : valores.usuarioId, valores.acao, String(valores.referencia),
      valores.contexto ?? null, valores.anteriores ?? null, valores.novos ?? null, valores.em],
  );
  const instantaneo = (gheId, extra = {}) => ({
    matricula: 'LEG-1', nome: 'Pessoa Legada', grupoHomogeneoId: gheId, setor: 'Setor legado', funcao: 'Função legada', cracha: null, dataAdmissao: null, ativo: true, ...extra,
  });
  async function cadastrar(gheId) {
    seq += 1;
    const r = await amb.como(amb.usuarios.master).post('/api/funcionarios', {
      nome: `Pessoa E ${seq}`, cpf: cpfFicticio(8800 + seq), grupoHomogeneoId: gheId, setor: 'Produção', funcao: 'Operador', dataAdmissao: '2026-01-05',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.funcionario.id;
  }
  const trocar = async (id, gheId) => {
    const r = await amb.como(amb.usuarios.master).patch(`/api/funcionarios/${id}`, { grupoHomogeneoId: gheId });
    assert.equal(r.status, 200, JSON.stringify(r.body));
  };

  before(async () => {
    amb = await montarAmbienteGhe();
    nomeMaster = (await amb.pool.query('SELECT nome FROM usuarios WHERE id = $1', [amb.usuarios.master])).rows[0].nome;
    const { soldagem, caldeiraria } = amb.ghes;

    // Atual: cadastro em Soldagem, troca para Caldeiraria, volta para Soldagem (cada troca: ALTERADO + GHE_ALTERADO).
    ids.atual = await cadastrar(soldagem);
    await trocar(ids.atual, caldeiraria);
    await trocar(ids.atual, soldagem);
    // Outros eventos do mesmo funcionário que NÃO são de GHE: setor, situação e consulta de CPF.
    for (const [nome, r] of [
      ['setor', await amb.como(amb.usuarios.master).patch(`/api/funcionarios/${ids.atual}`, { setor: 'Manutenção' })],
      ['situação', await amb.como(amb.usuarios.master).post(`/api/funcionarios/${ids.atual}/situacao`, { situacao: 'AFASTADO' })],
      ['CPF', await amb.como(amb.usuarios.master).post(`/api/funcionarios/${ids.atual}/cpf/revelar`, {})],
    ]) assert.equal(r.status, 200, `${nome}: ${JSON.stringify(r.body)}`);
    assert.deepEqual(await amb.eventos(ids.atual), [
      'FUNCIONARIO_CRIADO', 'FUNCIONARIO_ALTERADO', 'FUNCIONARIO_GHE_ALTERADO', 'FUNCIONARIO_ALTERADO', 'FUNCIONARIO_GHE_ALTERADO',
      'FUNCIONARIO_ALTERADO', 'FUNCIONARIO_SITUACAO_ALTERADA', 'FUNCIONARIO_CPF_CONSULTADO',
    ], 'os eventos reais gravados pelos serviços (pré-condição das fixtures)');
    // O nome e o código ATUAIS do GHE mudam depois: o histórico guarda os da época.
    await amb.pool.query("UPDATE grupos_homogeneos_exposicao SET nome = 'Caldeiraria renomeada', codigo = 'GHE-011' WHERE id = $1", [caldeiraria]);

    // Sem nenhum evento de GHE (semeado por SQL, sem cadastro auditado).
    ids.semEventos = await amb.trabalhadorNoGhe(soldagem);

    // Legado: cadastro sem a chave grupoHomogeneoId (anterior ao GHE), cadastro sem GHE, alteração só com ids (antes do
    // S3), alteração legada que não mexe no GHE, evento sem responsável e importação.
    ids.legado = await amb.trabalhadorNoGhe(caldeiraria);
    const L = ids.legado;
    await auditar({ acao: 'FUNCIONARIO_CRIADO', referencia: L, em: '2025-01-10T12:00:00Z', contexto: { criadoPor: amb.usuarios.master },
      novos: { matricula: 'LEG-1', nome: 'Pessoa Legada', setor: 'S', funcao: 'F', cracha: null, ativo: true } });
    await auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia: L, em: '2025-02-10T12:00:00Z', anteriores: instantaneo(null), novos: instantaneo(soldagem) });
    await auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia: L, em: '2025-03-10T12:00:00Z', anteriores: instantaneo(soldagem), novos: instantaneo(soldagem, { setor: 'Outro setor' }) });
    await auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia: L, em: '2025-04-10T12:00:00Z', usuarioId: null, anteriores: instantaneo(soldagem), novos: instantaneo(caldeiraria) });

    ids.importado = await amb.trabalhadorNoGhe(soldagem);
    await auditar({ acao: 'FUNCIONARIO_CRIADO', referencia: ids.importado, em: '2026-05-02T13:00:00Z',
      contexto: { criadoPor: amb.usuarios.master, origem: 'importacao', importacaoId: 'imp-e-1', linha: 7 }, novos: instantaneo(soldagem) });
    ids.cadastroSemGhe = await amb.trabalhadorNoGhe(null);
    await auditar({ acao: 'FUNCIONARIO_CRIADO', referencia: ids.cadastroSemGhe, em: '2025-06-01T12:00:00Z', contexto: { criadoPor: amb.usuarios.master }, novos: instantaneo(null) });

    // GREEN E — identificação atual: id de GHE de OUTRA empresa e id inexistente nunca ganham identificação.
    ids.semIdentificacao = await amb.trabalhadorNoGhe(soldagem);
    await auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia: ids.semIdentificacao, em: '2025-07-01T12:00:00Z',
      anteriores: instantaneo(amb.ghes.outraEmpresa), novos: instantaneo(999999) });

    // GREEN E — deduplicação segura: só some o ALTERADO que fecha a correlação inteira com um GHE_ALTERADO.
    ids.dedupe = await amb.trabalhadorNoGhe(soldagem);
    const D = ids.dedupe;
    const hist = (id, codigo, descricao) => ({ grupoHomogeneo: id === null ? null : ghe(id, codigo, descricao) });
    const S = [soldagem, 'GHE-020', 'Soldagem'];
    const C = [caldeiraria, 'GHE-010', 'Caldeiraria'];
    // mesmo instante e usuário, GHEs DIFERENTES → dois eventos
    await auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia: D, em: '2026-02-01T10:00:00Z', anteriores: instantaneo(soldagem), novos: instantaneo(caldeiraria) });
    await auditar({ acao: 'FUNCIONARIO_GHE_ALTERADO', referencia: D, em: '2026-02-01T10:00:00Z', anteriores: hist(...C), novos: hist(...S) });
    // mesmo instante e GHEs, usuário DIFERENTE → dois eventos
    await auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia: D, em: '2026-02-02T10:00:00Z', anteriores: instantaneo(soldagem), novos: instantaneo(caldeiraria) });
    await auditar({ acao: 'FUNCIONARIO_GHE_ALTERADO', referencia: D, usuarioId: amb.usuarios.comEditar, em: '2026-02-02T10:00:00Z', anteriores: hist(...S), novos: hist(...C) });
    // correlação completa (instante, usuário, GHE anterior e novo, gravado depois) → um evento só
    await auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia: D, em: '2026-02-03T10:00:00Z', anteriores: instantaneo(caldeiraria), novos: instantaneo(soldagem) });
    await auditar({ acao: 'FUNCIONARIO_GHE_ALTERADO', referencia: D, em: '2026-02-03T10:00:00Z', anteriores: hist(...C), novos: hist(...S) });

    // Mesma referência em outra empresa e em outra ação: nunca entram.
    await auditar({ empresaId: amb.d.empresaB, usuarioId: amb.usuarios.masterB, acao: 'FUNCIONARIO_GHE_ALTERADO', referencia: ids.atual, em: '2026-06-01T12:00:00Z',
      contexto: { origem: 'GESTAO_FUNCIONARIOS' }, anteriores: { grupoHomogeneo: null }, novos: { grupoHomogeneo: ghe(amb.ghes.outraEmpresa, 'GHE-001', 'Outra empresa') } });
    await auditar({ acao: 'MATERIAL_ALTERADO', referencia: ids.atual, em: '2026-06-02T12:00:00Z', anteriores: { grupoHomogeneoId: 1 }, novos: { grupoHomogeneoId: 2 } });
  });
  after(async () => { if (amb) await amb.encerrar(); });

  describe('E1 — eventos atuais (cadastro e trocas pela rota real)', () => {
    test('E1.1 cadastro + duas trocas: 3 eventos, mais recente primeiro; cada troca conta UMA vez (o par ALTERADO + GHE_ALTERADO não duplica)', async () => {
      const r = await eventosDe(amb.usuarios.soVisualizar, ids.atual);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.status, r.body.funcionarioId, r.body.tipo, r.body.total, r.body.pagina, r.body.limite], ['ok', ids.atual, 'GHE', 3, 1, 20]);
      assert.deepEqual(r.body.eventos.map((e) => e.tipo), ['ALTERACAO', 'ALTERACAO', 'CADASTRO']);
    });

    test('E1.2 trocas com GHE anterior e novo como gravados na época (código e descrição), mesmo depois de o GHE ser renomeado', async () => {
      const { eventos } = (await lerEventos(ids.atual));
      const { soldagem, caldeiraria } = amb.ghes;
      assert.deepEqual([eventos[0].anterior, eventos[0].novo], [ghe(caldeiraria, 'GHE-010', 'Caldeiraria'), ghe(soldagem, 'GHE-020', 'Soldagem')]);
      assert.deepEqual([eventos[1].anterior, eventos[1].novo], [ghe(soldagem, 'GHE-020', 'Soldagem'), ghe(caldeiraria, 'GHE-010', 'Caldeiraria')]);
    });

    test('E1.3 registro inicial: anterior null; o cadastro grava só o id do GHE → código e descrição null (nunca o nome atual como histórico)', async () => {
      const { eventos } = (await lerEventos(ids.atual));
      const inicial = eventos[2];
      assert.equal(inicial.anterior, null);
      assert.equal(inicial.novo.id, amb.ghes.soldagem);
      assert.equal(inicial.novo.codigo, null);
      assert.equal(inicial.novo.descricao, null);
    });

    test('E1.4 cada evento: id, tipo, ocorridoEm (ISO, ordem decrescente) e responsável { id, nome } — e NADA além disso', async () => {
      const { eventos } = (await lerEventos(ids.atual));
      for (const e of eventos) {
        assert.deepEqual(Object.keys(e).sort(), ['anterior', 'id', 'novo', 'ocorridoEm', 'responsavel', 'tipo']);
        assert.equal(typeof e.id, 'string');
        assert.ok(!Number.isNaN(Date.parse(e.ocorridoEm)), e.ocorridoEm);
        assert.deepEqual(e.responsavel, { id: amb.usuarios.master, nome: nomeMaster });
      }
      const instantes = eventos.map((e) => Date.parse(e.ocorridoEm));
      assert.deepEqual(instantes, [...instantes].sort((a, b) => b - a));
    });

    test('E1.5 eventos que não são de GHE (setor, situação, CPF consultado) nunca aparecem', async () => {
      const corpo = await lerEventos(ids.atual);
      assert.equal(corpo.total, 3);
      assert.equal(JSON.stringify(corpo).includes('AFASTADO'), false);
      assert.equal(JSON.stringify(corpo).includes('Manutenção'), false);
    });
  });

  describe('E2 — legados, importação e informação parcial', () => {
    test('E2.1 legado: só as alterações que mudaram o GHE, com ids apenas; cadastro sem a chave de GHE não é inventado; sem responsável = null', async () => {
      const r = await eventosDe(amb.usuarios.soVisualizar, ids.legado);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const { soldagem, caldeiraria } = amb.ghes;
      assert.deepEqual(r.body.eventos.map((e) => [e.tipo, e.ocorridoEm.slice(0, 10)]), [['ALTERACAO', '2025-04-10'], ['ALTERACAO', '2025-02-10']]);
      const [ultima, primeira] = r.body.eventos;
      assert.deepEqual([ultima.anterior, ultima.novo], [
        soId(soldagem, { codigo: 'GHE-020', descricao: 'Soldagem' }), soId(caldeiraria, { codigo: 'GHE-011', descricao: 'Caldeiraria renomeada' }),
      ]);
      assert.equal(ultima.responsavel, null, 'evento sem usuário: responsável indisponível');
      assert.deepEqual([primeira.anterior, primeira.novo], [null, soId(soldagem, { codigo: 'GHE-020', descricao: 'Soldagem' })]);
      assert.deepEqual(primeira.responsavel, { id: amb.usuarios.master, nome: nomeMaster });
    });

    test('E2.2 importação com evento individual: tipo IMPORTACAO, anterior null, novo só com o id', async () => {
      const r = await eventosDe(amb.usuarios.soVisualizar, ids.importado);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(r.body.eventos.map((e) => e.tipo), ['IMPORTACAO']);
      assert.deepEqual([r.body.eventos[0].anterior, r.body.eventos[0].novo], [null, soId(amb.ghes.soldagem, { codigo: 'GHE-020', descricao: 'Soldagem' })]);
    });

    test('E2.3 cadastro sem GHE: registro inicial com novo null', async () => {
      const corpo = await lerEventos(ids.cadastroSemGhe);
      assert.deepEqual(corpo.eventos.map((e) => [e.tipo, e.anterior, e.novo]), [['CADASTRO', null, null]]);
    });

    test('E2.4 funcionário sem nenhum evento de GHE: lista vazia, total 0 (resposta válida, não erro)', async () => {
      const r = await eventosDe(amb.usuarios.soVisualizar, ids.semEventos);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual([r.body.eventos, r.body.total], [[], 0]);
    });
  });

  describe('E3 — paginação real', () => {
    test('E3.1 limite 2: página 1 com 2, página 2 com 1, total 3 nas duas; sem repetir nem perder evento', async () => {
      const p1 = await lerEventos(ids.atual, 'tipo=GHE&pagina=1&limite=2');
      const p2 = await lerEventos(ids.atual, 'tipo=GHE&pagina=2&limite=2');
      assert.deepEqual([p1.eventos.length, p1.total, p1.limite, p2.eventos.length, p2.total, p2.pagina], [2, 3, 2, 1, 3, 2]);
      const todos = (await lerEventos(ids.atual)).eventos.map((e) => e.id);
      assert.deepEqual([...p1.eventos, ...p2.eventos].map((e) => e.id), todos);
    });

    // Adaptação autorizada no GREEN F: SITUACAO passou a ser tipo válido (pacote F); um tipo ainda inexistente continua 400.
    test('E3.2 parâmetros: tipo obrigatório (GHE e SITUACAO válidos, outro → 400); limite 1–100; id inválido → 400', async () => {
      assert.equal((await eventosDe(amb.usuarios.soVisualizar, ids.atual, 'tipo=SITUACAO&pagina=1&limite=20')).status, 200, 'SITUACAO é tipo válido');
      for (const q of ['pagina=1&limite=20', 'tipo=CADASTRO&pagina=1&limite=20', 'tipo=GHE&pagina=1&limite=101', 'tipo=GHE&pagina=0&limite=20', 'tipo=GHE&pagina=1&limite=20&empresaId=2']) {
        const r = await eventosDe(amb.usuarios.soVisualizar, ids.atual, q);
        assert.equal(r.status, 400, `${q}: ${JSON.stringify(r.body)}`);
      }
      const invalido = await get(amb.usuarios.soVisualizar, '/api/funcionarios/abc/eventos?tipo=GHE&pagina=1&limite=20');
      assert.equal(invalido.status, 400);
    });
  });

  describe('E5 — identificação atual e deduplicação segura (GREEN E)', () => {
    test('E5.1 só o GHE gravado pelo id ganha `atual` (identificação de hoje); o gravado com código e descrição fica como era, sem `atual`', async () => {
      const { eventos } = await lerEventos(ids.atual);
      for (const e of eventos.slice(0, 2)) {
        for (const g of [e.anterior, e.novo]) assert.equal(Object.hasOwn(g, 'atual'), false, `troca do S3 não leva atual: ${JSON.stringify(g)}`);
      }
      assert.deepEqual(eventos[1].novo, ghe(amb.ghes.caldeiraria, 'GHE-010', 'Caldeiraria'), 'o histórico não vira o nome atual');
      assert.deepEqual(eventos[2].novo, soId(amb.ghes.soldagem, { codigo: 'GHE-020', descricao: 'Soldagem' }));
    });

    test('E5.2 id de GHE de outra empresa ou inexistente: `atual` null (nunca a identificação de outra empresa)', async () => {
      const { eventos } = await lerEventos(ids.semIdentificacao);
      assert.equal(eventos.length, 1);
      assert.deepEqual([eventos[0].anterior, eventos[0].novo], [soId(amb.ghes.outraEmpresa, null), soId(999999, null)]);
      assert.equal(JSON.stringify(eventos).includes('Outra empresa'), false);
    });

    test('E5.3 deduplicação: some só o ALTERADO que fecha a correlação inteira; GHEs ou usuário diferentes no mesmo instante continuam', async () => {
      const { eventos, total } = await lerEventos(ids.dedupe);
      assert.equal(total, 5, JSON.stringify(eventos.map((e) => [e.ocorridoEm, e.responsavel?.id])));
      const porDia = (dia) => eventos.filter((e) => e.ocorridoEm.startsWith(dia)).length;
      assert.deepEqual([porDia('2026-02-03'), porDia('2026-02-02'), porDia('2026-02-01')], [1, 2, 2]);
      const correlacionado = eventos.find((e) => e.ocorridoEm.startsWith('2026-02-03'));
      assert.deepEqual([correlacionado.anterior, correlacionado.novo], [ghe(amb.ghes.caldeiraria, 'GHE-010', 'Caldeiraria'), ghe(amb.ghes.soldagem, 'GHE-020', 'Soldagem')], 'fica o evento do S3, com o histórico');
    });
  });

  describe('E4 — segurança', () => {
    test('E4.1 só employeeHistory.visualizar basta (sem reportsAudit); sem a permissão → 403; sem sessão → 401', async () => {
      assert.equal((await eventosDe(amb.usuarios.soVisualizar, ids.atual)).status, 200);
      assert.equal((await eventosDe(amb.usuarios.semPermissao, ids.atual)).status, 403);
      const anonimo = await require('supertest')(amb.app).get(`/api/funcionarios/${ids.atual}/eventos?tipo=GHE&pagina=1&limite=20`);
      assert.equal(anonimo.status, 401);
    });

    test('E4.2 funcionário inexistente e de outra empresa: o mesmo 404 FUNCIONARIO_NAO_ENCONTRADO (status e corpo)', async () => {
      const inexistente = await eventosDe(amb.usuarios.soVisualizar, 999999);
      const outraEmpresa = await eventosDe(amb.usuarios.masterB, ids.atual);
      assert.deepEqual([inexistente.status, inexistente.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
      assert.deepEqual([outraEmpresa.status, outraEmpresa.body], [inexistente.status, inexistente.body]);
    });

    test('E4.3 eventos da mesma referência em outra empresa ou em outra ação nunca entram', async () => {
      const corpo = await lerEventos(ids.atual);
      assert.equal(corpo.total, 3);
      assert.equal(JSON.stringify(corpo).includes('Outra empresa'), false);
      assert.equal(JSON.stringify(corpo).includes('GHE-001'), false);
    });

    test('E4.4 nada sensível ou interno na resposta: sem JSON bruto, contexto, ip, dispositivo, perfil, CPF, instantâneo do cadastro', async () => {
      for (const id of [ids.atual, ids.legado, ids.importado]) {
        const corpo = await lerEventos(id);
        assert.ok(corpo.eventos.length > 0, `funcionário ${id}: há eventos para inspecionar`);
        const texto = JSON.stringify(corpo);
        for (const proibido of ['contexto', 'dadosAnteriores', 'dadosNovos', 'dados_anteriores', 'dados_novos', 'acao', 'referencia', '"ip"', '203.0.113', 'dispositivo',
          'Navegador', 'perfil', 'cpf', 'telefone', 'dataNascimento', 'matricula', 'setor', 'funcao', 'importacaoId', 'imp-e-1', 'camposSensiveis', 'criadoPor', 'GESTAO_FUNCIONARIOS']) {
          assert.equal(texto.includes(proibido), false, `funcionário ${id}: a resposta contém ${proibido}`);
        }
      }
    });
  });
});
