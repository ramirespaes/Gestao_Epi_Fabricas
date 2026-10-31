'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteSituacaoDatas } = require('./helpers/ambiente-funcionario-situacao-datas');

/**
 * Edição da admissão (PATCH) × histórico imutável de situações (PostgreSQL real, schema temporário; achado A1 do parecer
 * independente de 30/10/2026). A admissão nunca pode passar a ser POSTERIOR à primeira data efetiva registrada; igual ou anterior
 * vale. Sem histórico com data, nada é inventado. Relógio fixo: "hoje" = 2026-10-10. A conferência corre sob a trava do funcionário:
 * mudança de situação e edição de admissão simultâneas nunca deixam o par inconsistente.
 */

const ROTA = (id) => `/api/funcionarios/${id}`;
const SIT = (id) => `/api/funcionarios/${id}/situacao`;

describe('admissão × histórico de situações (HTTP + PostgreSQL)', () => {
  let amb;
  before(async () => { amb = await montarAmbienteSituacaoDatas(); });
  after(async () => { if (amb) await amb.encerrar(); });

  const master = () => amb.usuarios.master;
  const patch = (id, corpo, usuario = master()) => amb.como(usuario).patch(ROTA(id), corpo);
  const situacao = (id, corpo, usuario = master()) => amb.como(usuario).post(SIT(id), corpo);
  const admissaoDe = async (id) => (await amb.ler(id)).data_admissao;
  const desligado = async (data = '2026-10-05', admissao = '2020-01-01') => {
    const id = await amb.trabalhador({ admissao });
    const r = await situacao(id, { situacao: 'INATIVO', dataEfetiva: data });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    return id;
  };
  const alteracoes = async (id) => (await amb.auditoria('FUNCIONARIO_ALTERADO', id)).length;

  test('admissão posterior à primeira data efetiva: 409 com o limite; admissão, atualizado_em e auditoria intactos', async () => {
    const id = await desligado('2026-10-05');
    const antes = await amb.ler(id);
    const r = await patch(id, { dataAdmissao: '2026-10-06' });
    assert.deepEqual([r.status, r.body.codigo], [409, 'FUNCIONARIO_DATA_ADMISSAO_POSTERIOR_A_SITUACAO'], JSON.stringify(r.body));
    assert.deepEqual(r.body.detalhes, { limite: '2026-10-05' });
    assert.deepEqual(await amb.ler(id), antes, 'nada muda');
    assert.equal(await alteracoes(id), 0, 'nenhuma auditoria de alteração');
    assert.equal(JSON.stringify(r.body).match(/cpf|telefone|nascimento/i), null, 'sem dado pessoal no erro');
  });

  test('admissão IGUAL e ANTERIOR à primeira data efetiva valem; o histórico não muda', async () => {
    const a = await desligado('2026-10-05');
    assert.equal((await patch(a, { dataAdmissao: '2026-10-05' })).status, 200);
    assert.equal(await admissaoDe(a), '2026-10-05');
    const b = await desligado('2026-10-05');
    assert.equal((await patch(b, { dataAdmissao: '2026-10-04' })).status, 200);
    assert.equal(await admissaoDe(b), '2026-10-04');
    assert.equal((await amb.historico(b)).length, 1);
  });

  test('o limite é a MENOR data efetiva do histórico (várias linhas), e a reativação sem data não cria limite', async () => {
    const id = await amb.trabalhador({ admissao: '2020-01-01' });
    assert.equal((await situacao(id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-03' })).status, 200);
    assert.equal((await situacao(id, { situacao: 'ATIVO', dataEfetiva: '2026-10-07' })).status, 200);
    const r = await patch(id, { dataAdmissao: '2026-10-05' });
    assert.deepEqual([r.status, r.body.codigo, r.body.detalhes?.limite], [409, 'FUNCIONARIO_DATA_ADMISSAO_POSTERIOR_A_SITUACAO', '2026-10-03']);
    const reativado = await amb.trabalhador({ situacao: 'INATIVO', admissao: '2020-01-01' });
    assert.equal((await situacao(reativado, { situacao: 'ATIVO' })).status, 200, 'reativação de INATIVO sem data');
    assert.equal((await patch(reativado, { dataAdmissao: '2026-10-09' })).status, 200, 'linha com data nula não limita');
  });

  test('sem histórico com data (legado ou nunca mudou de situação): nenhum limite é inventado', async () => {
    const legado = await amb.trabalhador({ situacao: 'INATIVO', admissao: '2020-01-01' });
    assert.equal((await patch(legado, { dataAdmissao: '2026-10-09' })).status, 200);
    const ativo = await amb.trabalhador({ admissao: '2020-01-01' });
    assert.equal((await patch(ativo, { dataAdmissao: '2026-10-09' })).status, 200);
  });

  test('os outros campos nunca são afetados; e a recusa da admissão não grava os outros campos do mesmo PATCH', async () => {
    const id = await desligado('2026-10-05');
    assert.equal((await patch(id, { setor: 'Caldeiraria' })).status, 200);
    const funcao = async () => (await amb.pool.query('SELECT funcao FROM funcionarios WHERE id = $1', [id])).rows[0].funcao;
    const antes = await amb.ler(id);
    const funcaoAntes = await funcao();
    const r = await patch(id, { dataAdmissao: '2026-10-06', funcao: 'Soldador' });
    assert.equal(r.status, 409);
    assert.deepEqual(await amb.ler(id), antes);
    assert.equal(await funcao(), funcaoAntes, 'a função do mesmo PATCH também não foi gravada');
    assert.notEqual(funcaoAntes, 'Soldador');
  });

  test('as validações anteriores seguem na frente: futura e anterior ao nascimento continuam 400', async () => {
    const id = await desligado('2026-10-05');
    const futura = await patch(id, { dataAdmissao: '2026-10-11' });
    assert.deepEqual([futura.status, futura.body.codigo], [400, 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA']);
  });

  test('empresa e permissão: outra empresa recebe o mesmo 404 e nada muda; só visualizar recebe 403', async () => {
    const id = await desligado('2026-10-05');
    const antes = await amb.ler(id);
    const cruzado = await patch(id, { dataAdmissao: '2026-10-06' }, amb.usuarios.masterB);
    assert.deepEqual([cruzado.status, cruzado.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
    assert.equal((await patch(id, { dataAdmissao: '2026-10-06' }, amb.usuarios.soVisualizar)).status, 403);
    assert.equal((await patch(id, { dataAdmissao: '2026-10-06' }, amb.usuarios.semPermissao)).status, 403);
    assert.deepEqual(await amb.ler(id), antes);
    assert.equal((await patch(id, { dataAdmissao: '2026-10-04' }, amb.usuarios.comEditar)).status, 200, 'quem edita e respeita o limite consegue');
  });

  test('o histórico continua utilizável depois da recusa: a mesma pessoa pode voltar a ser reativada e desligada', async () => {
    const id = await desligado('2026-10-05');
    assert.equal((await patch(id, { dataAdmissao: '2026-10-06' })).status, 409);
    assert.equal((await situacao(id, { situacao: 'ATIVO' })).status, 200);
    assert.equal((await amb.historico(id)).length, 2);
  });

  test('concorrência: situação e edição de admissão simultâneas nunca deixam admissão posterior à primeira data efetiva', async () => {
    const ids = [];
    for (let i = 0; i < 8; i += 1) ids.push(await amb.trabalhador({ admissao: '2020-01-01' }));
    const resultados = await Promise.all(ids.flatMap((id) => [
      situacao(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-05' }),
      patch(id, { dataAdmissao: '2026-10-08' }),
    ]));
    for (let i = 0; i < ids.length; i += 1) {
      const [s, p] = [resultados[2 * i], resultados[2 * i + 1]];
      assert.equal(s.status === 200 && p.status === 200, false, `trabalhador ${ids[i]}: as duas operações não podem vencer juntas (${s.status}/${p.status})`);
      const adm = await admissaoDe(ids[i]);
      const hist = await amb.historico(ids[i]);
      const primeira = hist.map((h) => h.data_efetiva).filter(Boolean).sort()[0];
      if (primeira) assert.ok(adm <= primeira, `admissão ${adm} posterior à primeira data efetiva ${primeira}`);
      const esperado = s.status === 200 ? [409, 'FUNCIONARIO_DATA_ADMISSAO_POSTERIOR_A_SITUACAO'] : [200, undefined];
      if (s.status === 200) assert.deepEqual([p.status, p.body.codigo], esperado);
      else assert.equal(s.body.codigo, 'DATA_EFETIVA_ANTERIOR_A_ADMISSAO');
    }
  });
});
