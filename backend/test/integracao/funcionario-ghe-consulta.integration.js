'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteGhe } = require('./helpers/ambiente-funcionario-ghe');

/**
 * S3 (RED) — as respostas de funcionário passam a expor o GHE ATUAL com os dados operacionais:
 *   grupoHomogeneo: { id, codigo, descricao } | null
 * (`codigo` = código do GHE; `descricao` = `nome` físico, a descrição operacional; colunas físicas intactas). Funcionário
 * sem GHE (legado) continua válido e vem com `grupoHomogeneo: null`. `grupoHomogeneoId` segue na resposta, por
 * compatibilidade. Sem CPF completo.
 *
 * Cobre a listagem, a consulta individual e a consulta por CPF, e a resposta de criação e de alteração. Toda falha é de
 * comportamento ausente (o campo ainda não existe), nunca de harness.
 */

describe('S3 — GHE atual nas respostas de funcionário', () => {
  let amb;
  before(async () => { amb = await montarAmbienteGhe(); });
  after(async () => { if (amb) await amb.encerrar(); });

  const master = () => amb.usuarios.master;
  const dadosDe = (id, codigo, descricao) => ({ id, codigo, descricao });

  test('listagem: cada funcionário traz grupoHomogeneo { id, codigo, descricao } e mantém grupoHomogeneoId', async () => {
    const comGhe = await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    const r = await amb.como(master()).get('/api/funcionarios?limite=100');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const linha = r.body.funcionarios.find((f) => f.id === comGhe);
    assert.ok(linha, 'funcionário não listado');
    assert.deepEqual(linha.grupoHomogeneo, dadosDe(amb.ghes.soldagem, 'GHE-020', 'Soldagem'));
    assert.equal(linha.grupoHomogeneoId, amb.ghes.soldagem);
    assert.equal(linha.cpf, undefined);
  });

  test('listagem: o filtro por GHE continua e todos os funcionários filtrados trazem o mesmo GHE', async () => {
    const a = await amb.trabalhadorNoGhe(amb.ghes.caldeiraria);
    const b = await amb.trabalhadorNoGhe(amb.ghes.caldeiraria);
    await amb.trabalhadorNoGhe(amb.ghes.soldagem);
    const r = await amb.como(master()).get(`/api/funcionarios?grupoHomogeneoId=${amb.ghes.caldeiraria}&limite=100`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.funcionarios.map((f) => f.id).sort((x, y) => x - y), [a, b].sort((x, y) => x - y));
    for (const f of r.body.funcionarios) assert.deepEqual(f.grupoHomogeneo, dadosDe(amb.ghes.caldeiraria, 'GHE-010', 'Caldeiraria'));
  });

  test('consulta individual e por CPF expõem o mesmo GHE; GHE legado sem código vem com codigo nulo', async () => {
    const id = await amb.trabalhadorNoGhe(amb.ghes.legado);
    // A consulta por CPF exige CPF com dígitos verificadores; os do mundo base são só sequenciais.
    const cpf = '11144477735';
    await amb.pool.query('UPDATE funcionarios SET cpf = $2 WHERE id = $1', [id, cpf]);
    const individual = await amb.como(master()).get(`/api/funcionarios/${id}`);
    assert.equal(individual.status, 200, JSON.stringify(individual.body));
    assert.deepEqual(individual.body.funcionario.grupoHomogeneo, dadosDe(amb.ghes.legado, null, 'GHE A'));
    const porCpf = await amb.como(master()).post('/api/funcionarios/consulta-cpf', { cpf });
    assert.equal(porCpf.status, 200, JSON.stringify(porCpf.body));
    assert.deepEqual(porCpf.body.funcionarios[0].grupoHomogeneo, dadosDe(amb.ghes.legado, null, 'GHE A'));
  });

  test('funcionário sem GHE: continua listável e consultável, com grupoHomogeneo nulo (não ausente) e grupoHomogeneoId nulo', async () => {
    const id = await amb.trabalhadorNoGhe(null);
    const individual = await amb.como(master()).get(`/api/funcionarios/${id}`);
    assert.equal(individual.status, 200, JSON.stringify(individual.body));
    assert.equal(individual.body.funcionario.grupoHomogeneoId, null);
    assert.ok(Object.hasOwn(individual.body.funcionario, 'grupoHomogeneo'), 'a chave grupoHomogeneo deveria existir');
    assert.equal(individual.body.funcionario.grupoHomogeneo, null);
    const lista = await amb.como(master()).get('/api/funcionarios?limite=100');
    assert.equal(lista.body.funcionarios.find((f) => f.id === id)?.grupoHomogeneo, null);
  });

  test('funcionário vinculado a um GHE depois inativado continua exibindo o GHE dele (inativar o GHE não desvincula)', async () => {
    const id = await amb.trabalhadorNoGhe(amb.ghes.encerrado);
    const r = await amb.como(master()).get(`/api/funcionarios/${id}`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.funcionario.grupoHomogeneo, dadosDe(amb.ghes.encerrado, 'GHE-005', 'Setor encerrado'));
  });

  test('criar com GHE e alterar o GHE devolvem o GHE novo na resposta; só dados da própria empresa', async () => {
    const criado = await amb.como(master()).post('/api/funcionarios', {
      matricula: 'S3-NOVO-1', nome: 'Novo com GHE', cpf: '52998224725', grupoHomogeneoId: amb.ghes.soldagem,
      setor: 'Manutenção', funcao: 'Mecânico', dataAdmissao: '2020-06-01', // S4: obrigatórios do cadastro
    });
    assert.equal(criado.status, 201, JSON.stringify(criado.body));
    assert.deepEqual(criado.body.funcionario.grupoHomogeneo, dadosDe(amb.ghes.soldagem, 'GHE-020', 'Soldagem'));
    const alterado = await amb.como(master()).patch(`/api/funcionarios/${criado.body.funcionario.id}`, { grupoHomogeneoId: amb.ghes.caldeiraria });
    assert.equal(alterado.status, 200, JSON.stringify(alterado.body));
    assert.deepEqual(alterado.body.funcionario.grupoHomogeneo, dadosDe(amb.ghes.caldeiraria, 'GHE-010', 'Caldeiraria'));
  });
});
