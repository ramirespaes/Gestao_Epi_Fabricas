'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteGhe } = require('./helpers/ambiente-funcionario-ghe');
const { cpfFicticio } = require('../helpers/cpf-ficticio');

/**
 * Histórico de Funcionários — pacote G, complemento RED: DATA DE ADMISSÃO no histórico cadastral (tipo=CADASTRAL).
 *
 * Decisões de 11/10/2026: data de admissão entra (campo público `dataAdmissao`, rótulo "Data de admissão"); crachá NÃO
 * entra; um evento por operação, com todos os campos realmente modificados. Ordem dos campos: nome, matricula, setor,
 * funcao, dataAdmissao.
 * Formato real (confirmado no código e conferido aqui na linha da auditoria): o repositório lê `to_char(data_admissao,
 * 'YYYY-MM-DD')` e o instantâneo grava esse texto; a API devolve o MESMO texto YYYY-MM-DD, sem hora nem fuso.
 * Só valores do próprio evento: nunca o cadastro atual; registro antigo sem a chave `dataAdmissao` (antes de 536fd49) não
 * ganha data inventada.
 */

describe('G (complemento) — data de admissão no histórico cadastral (PostgreSQL real)', () => {
  let amb;
  const ids = {};
  const CPF = cpfFicticio(9400);

  const eventosDe = (usuarioId, id) => amb.como(usuarioId).get(`/api/funcionarios/${id}/eventos?tipo=CADASTRAL&pagina=1&limite=20`);
  async function lerEventos(id) {
    const r = await eventosDe(amb.usuarios.soVisualizar, id);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body.eventos), JSON.stringify(r.body));
    return r.body;
  }
  const auditar = (v) => amb.pool.query(
    `INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, contexto, dados_anteriores, dados_novos, criado_em)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [amb.d.empresaA, amb.usuarios.master, v.acao, String(v.referencia), v.contexto ?? null, v.anteriores ?? null, v.novos ?? null, v.em],
  );
  const patch = async (id, corpo) => {
    const r = await amb.como(amb.usuarios.master).patch(`/api/funcionarios/${id}`, corpo);
    assert.equal(r.status, 200, `${JSON.stringify(corpo)}: ${JSON.stringify(r.body)}`);
  };
  const doCampo = (e, campo) => e.alteracoes.find((a) => a.campo === campo);
  const resumo = (eventos) => eventos.map((e) => [e.tipo, e.alteracoes.map((a) => [a.campo, a.anterior, a.novo])]);

  before(async () => {
    amb = await montarAmbienteGhe();
    const criado = await amb.como(amb.usuarios.master).post('/api/funcionarios', {
      nome: 'Pessoa Admissão', cpf: CPF, matricula: 'ADM-1', grupoHomogeneoId: amb.ghes.soldagem, setor: 'Produção', funcao: 'Operador',
      cracha: 'CR-777', telefone: '47999991234', dataNascimento: '1988-07-20', dataAdmissao: '2026-01-05',
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    ids.atual = criado.body.funcionario.id;
    const A = ids.atual;
    await patch(A, { dataAdmissao: '2026-02-01' });                    // muda a data
    await patch(A, { dataAdmissao: '2026-02-01' });                    // mesma data: sem mudança
    await patch(A, { dataAdmissao: '2026-03-02', setor: 'Manutenção' }); // data + outro campo no mesmo evento
    await patch(A, { cracha: 'CR-888' });                              // só crachá: fora do histórico
    assert.deepEqual(await amb.eventos(A), ['FUNCIONARIO_CRIADO', 'FUNCIONARIO_ALTERADO', 'FUNCIONARIO_ALTERADO', 'FUNCIONARIO_ALTERADO', 'FUNCIONARIO_ALTERADO']);

    // Formato real gravado: texto YYYY-MM-DD no instantâneo.
    const [criacao] = await amb.auditoria('FUNCIONARIO_CRIADO', A);
    ids.formatoGravado = criacao.dados_novos.dataAdmissao;

    // Legado: cópia sem a chave dataAdmissao (antes de 536fd49), na criação e numa alteração de nome.
    ids.legado = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    const antigo = (extra) => ({ matricula: 'OLD-1', nome: 'Pessoa Antiga', grupoHomogeneoId: null, setor: 'S', funcao: 'F', cracha: null, ativo: true, ...extra });
    await auditar({ acao: 'FUNCIONARIO_CRIADO', referencia: ids.legado, em: '2025-01-10T12:00:00Z', novos: antigo() });
    await auditar({ acao: 'FUNCIONARIO_ALTERADO', referencia: ids.legado, em: '2025-02-10T12:00:00Z', anteriores: antigo(), novos: antigo({ nome: 'Pessoa Antiga II' }) });

    // Importação com a data de admissão no instantâneo (mesmo formato do serviço).
    ids.importado = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    await auditar({ acao: 'FUNCIONARIO_CRIADO', referencia: ids.importado, em: '2026-05-02T13:00:00Z', contexto: { criadoPor: amb.usuarios.master, origem: 'importacao', importacaoId: 'imp-adm', linha: 2 },
      novos: { matricula: 'IMP-ADM', nome: 'Pessoa Importada Adm', grupoHomogeneoId: null, setor: 'Setor I', funcao: 'Função I', cracha: null, dataAdmissao: '2025-11-03', ativo: true } });
  });
  after(async () => { if (amb) await amb.encerrar(); });

  test('AD0 formato real: a auditoria grava a data de admissão como texto YYYY-MM-DD', () => {
    assert.equal(ids.formatoGravado, '2026-01-05');
  });

  test('AD1 cadastro inicial: dataAdmissao com o valor do evento (anterior null), no formato YYYY-MM-DD', async () => {
    const { eventos } = await lerEventos(ids.atual);
    const inicial = eventos.at(-1);
    assert.equal(inicial.tipo, 'CADASTRO');
    assert.deepEqual(doCampo(inicial, 'dataAdmissao'), { campo: 'dataAdmissao', anterior: null, novo: '2026-01-05' });
  });

  test('AD2 importação: dataAdmissao do instantâneo da importação', async () => {
    const { eventos } = await lerEventos(ids.importado);
    assert.equal(eventos[0].tipo, 'IMPORTACAO');
    assert.deepEqual(doCampo(eventos[0], 'dataAdmissao'), { campo: 'dataAdmissao', anterior: null, novo: '2025-11-03' });
  });

  test('AD3 alteração real da data, data informada SEM mudança e data + setor no mesmo evento; crachá nunca', async () => {
    const corpo = await lerEventos(ids.atual);
    assert.equal(corpo.total, 3, 'cadastro, mudança da data e data + setor — a data repetida e o crachá não viram evento');
    assert.deepEqual(resumo(corpo.eventos).slice(0, 2), [
      ['ALTERACAO', [['setor', 'Produção', 'Manutenção'], ['dataAdmissao', '2026-02-01', '2026-03-02']]],
      ['ALTERACAO', [['dataAdmissao', '2026-01-05', '2026-02-01']]],
    ]);
    for (const e of corpo.eventos) assert.equal(e.alteracoes.some((a) => a.campo === 'cracha'), false, 'crachá não entra');
  });

  test('AD4 registro antigo sem a chave dataAdmissao: nenhuma data inventada (nem na criação, nem na alteração)', async () => {
    const { eventos } = await lerEventos(ids.legado);
    assert.deepEqual(resumo(eventos), [
      ['ALTERACAO', [['nome', 'Pessoa Antiga', 'Pessoa Antiga II']]],
      ['CADASTRO', [['nome', null, 'Pessoa Antiga'], ['matricula', null, 'OLD-1'], ['setor', null, 'S'], ['funcao', null, 'F']]],
    ]);
  });

  test('AD5 segurança: nada de CPF, telefone, nascimento, crachá ou valores com hora/fuso', async () => {
    const texto = JSON.stringify(await lerEventos(ids.atual));
    for (const proibido of [CPF, '47999991234', '1988-07-20', 'dataNascimento', 'telefone', 'cracha', 'CR-777', 'CR-888']) {
      assert.equal(texto.includes(proibido), false, `contém ${proibido}`);
    }
    for (const e of (await lerEventos(ids.atual)).eventos) {
      const a = doCampo(e, 'dataAdmissao');
      if (a) for (const v of [a.anterior, a.novo]) assert.ok(v === null || /^\d{4}-\d{2}-\d{2}$/.test(v), `data inequívoca: ${v}`);
    }
  });
});
