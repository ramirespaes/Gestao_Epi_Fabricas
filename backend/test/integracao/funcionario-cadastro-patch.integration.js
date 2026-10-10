'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteCadastro } = require('./helpers/ambiente-funcionario-cadastro');
const { cpfFicticio } = require('../helpers/cpf-ficticio');

/**
 * S4 (RED) — edição individual: `PATCH /api/funcionarios/:id` e a regra definitiva do vínculo com o GHE.
 *
 * PATCH continua PARCIAL (só o enviado muda; o omitido fica; legado incompleto segue editável; matrícula nunca é gerada;
 * o GHE nunca muda implicitamente) e o CPF continua imutável. Regra definitiva do GHE:
 *   A → B e null → GHE: permitidos (S3 já cobre as trocas e a auditoria); null → null (legado): permitido;
 *   omitido: preserva; GHE → null: RECUSADO, sem efeito algum (nenhum campo muda, nenhum evento nasce).
 * O código de domínio da recusa GHE → null AINDA NÃO está aprovado: os testes exigem rejeição de cliente (4xx com corpo de erro
 * e código textual) e a ausência de efeitos, sem fixar o código. As datas estão em \`funcionario-cadastro-datas\`.
 *
 * Atenção ao GREEN: dois testes anteriores codificam o contrato legado "desvincular" e terão de acompanhar a regra nova
 * (funcionario-ghe-troca: "desvincular … é troca real"; funcionario-ghe-routes: "PATCH desvincula (null)").
 */

describe('S4 — edição individual (PATCH /funcionarios/:id) e vínculo com o GHE', () => {
  let amb;
  before(async () => { amb = await montarAmbienteCadastro(); });
  after(async () => { if (amb) await amb.encerrar(); });

  const alterar = (id, corpo, usuario = amb.usuarios.master) => amb.comoFixo(usuario).patch(`/api/funcionarios/${id}`, corpo);
  const completo = async () => {
    const r = await amb.comoFixo(amb.usuarios.master).post('/api/funcionarios', amb.corpoValido({ telefone: '47988880003', dataNascimento: '1990-03-15', cracha: 'CR-S4' }));
    assert.equal(r.status, 201, JSON.stringify(r.body));
    return r.body.funcionario.id;
  };

  describe('parcialidade e preservação', () => {
    test('só o enviado muda: o resto da linha (inclusive opcionais) fica idêntico; FUNCIONARIO_ALTERADO preservado', async () => {
      const id = await completo();
      const antes = await amb.linha(id);
      const r = await alterar(id, { nome: 'Nome Novo S4' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const { nome: nomeDepois, atualizado_em: _d, ...restoDepois } = await amb.linha(id);
      const { nome: nomeAntes, atualizado_em: _a, ...restoAntes } = antes;
      assert.equal(nomeDepois, 'Nome Novo S4');
      assert.notEqual(nomeAntes, nomeDepois);
      assert.deepEqual(restoDepois, restoAntes);
      assert.equal((await amb.eventosDe(id)).filter((e) => e === 'FUNCIONARIO_ALTERADO').length, 1);
    });

    test('cada campo editável, enviado sozinho, muda só ele', async () => {
      const id = await completo();
      for (const [campo, fisico, valor] of [['setor', 'setor', 'Setor Novo'], ['funcao', 'funcao', 'Função Nova'], ['telefone', 'telefone', '47988880004'], ['matricula', 'matricula', 'MAT-NOVA-S4']]) {
        // eslint-disable-next-line no-await-in-loop
        const antes = await amb.linha(id);
        // eslint-disable-next-line no-await-in-loop
        const r = await alterar(id, { [campo]: valor });
        assert.equal(r.status, 200, `${campo}: ${JSON.stringify(r.body)}`);
        // eslint-disable-next-line no-await-in-loop
        const depois = await amb.linha(id);
        assert.equal(depois[fisico], valor);
        for (const [coluna, v] of Object.entries(antes)) {
          if (coluna !== fisico && coluna !== 'atualizado_em') assert.deepEqual(depois[coluna], v, `${campo} mexeu em ${coluna}`);
        }
      }
    });

    test('legado incompleto (sem setor, função, datas) é editável em outro campo, sem exigir os obrigatórios do cadastro', async () => {
      const id = await amb.legado();
      const r = await alterar(id, { nome: 'Legado Editado' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const depois = await amb.linha(id);
      assert.deepEqual([depois.setor, depois.funcao, depois.data_nascimento, depois.data_admissao], [null, null, null, null]);
    });

    test('a matrícula nunca é gerada pela edição: quem não tem continua sem', async () => {
      const criado = await amb.comoFixo(amb.usuarios.master).post('/api/funcionarios', amb.corpoValido({ matricula: undefined }));
      assert.equal(criado.status, 201, JSON.stringify(criado.body));
      const r = await alterar(criado.body.funcionario.id, { setor: 'Qualquer' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.funcionario.matricula, null);
    });

    test('PATCH vazio continua 400 FUNCIONARIO_SEM_ALTERACAO', async () => {
      const id = await completo();
      const r = await alterar(id, {});
      assert.deepEqual([r.status, r.body.codigo], [400, 'FUNCIONARIO_SEM_ALTERACAO']);
    });
  });

  describe('CPF imutável; situação e ativo fora do PATCH', () => {
    test('enviar cpf no PATCH é recusado (400) e o CPF gravado não muda', async () => {
      const id = await completo();
      const antes = await amb.linha(id);
      for (const cpf of [cpfFicticio(888001), antes.cpf]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await alterar(id, { cpf });
        assert.equal(r.status, 400, JSON.stringify(r.body));
      }
      assert.deepEqual(await amb.linha(id), antes);
    });

    test('situacao e ativo seguem fora do PATCH genérico: 400 e nada muda (a mudança é a rota da situação, do S2)', async () => {
      const id = await completo();
      const antes = await amb.linha(id);
      for (const corpo of [{ situacao: 'AFASTADO' }, { ativo: false }]) {
        // eslint-disable-next-line no-await-in-loop
        assert.equal((await alterar(id, corpo)).status, 400, JSON.stringify(corpo));
      }
      assert.deepEqual(await amb.linha(id), antes);
    });
  });

  describe('regra definitiva do vínculo com o GHE', () => {
    const semEfeitos = async (id, corpo, antes, eventosAntes) => {
      const r = await alterar(id, corpo);
      assert.ok(r.status >= 400 && r.status < 500, `esperava rejeição de cliente, veio ${r.status}: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.status, 'error');
      assert.ok(typeof r.body.codigo === 'string' && r.body.codigo.length > 0, JSON.stringify(r.body));
      assert.deepEqual(await amb.linha(id), antes, 'nenhuma coluna deveria mudar');
      assert.deepEqual(await amb.eventosDe(id), eventosAntes, 'nenhum evento deveria nascer');
    };

    test('GHE → null é RECUSADO: o vínculo e todo o resto ficam intactos, sem FUNCIONARIO_ALTERADO nem FUNCIONARIO_GHE_ALTERADO', async () => {
      const id = await completo();
      const antes = await amb.linha(id);
      const eventosAntes = await amb.eventosDe(id);
      await semEfeitos(id, { grupoHomogeneoId: null }, antes, eventosAntes);
      assert.equal(await amb.gheDe(id), amb.ghes.soldagem);
    });

    test('GHE → null junto com outros campos recusa o PATCH inteiro (nada parcial)', async () => {
      const id = await completo();
      const antes = await amb.linha(id);
      const eventosAntes = await amb.eventosDe(id);
      await semEfeitos(id, { grupoHomogeneoId: null, setor: 'Mudou', telefone: '47988880005' }, antes, eventosAntes);
    });

    test('null → null (legado sem GHE) é permitido e não gera evento de GHE; o legado continua sem GHE', async () => {
      const id = await amb.legado({ gheId: null });
      const r = await alterar(id, { grupoHomogeneoId: null, setor: 'Expedição' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(await amb.gheDe(id), null);
      assert.equal(r.body.funcionario.grupoHomogeneo, null);
      assert.equal((await amb.eventosDe(id)).includes('FUNCIONARIO_GHE_ALTERADO'), false);
    });

    test('null → GHE (regulariza o legado) e A → B continuam permitidos', async () => {
      const id = await amb.legado({ gheId: null });
      const atribuido = await alterar(id, { grupoHomogeneoId: amb.ghes.soldagem });
      assert.equal(atribuido.status, 200, JSON.stringify(atribuido.body));
      const trocado = await alterar(id, { grupoHomogeneoId: amb.ghes.caldeiraria });
      assert.equal(trocado.status, 200, JSON.stringify(trocado.body));
      assert.equal(await amb.gheDe(id), amb.ghes.caldeiraria);
    });

    test('GHE omitido preserva o vínculo (e o legado sem GHE segue sem GHE)', async () => {
      const comGhe = await completo();
      assert.equal((await alterar(comGhe, { setor: 'Outro' })).status, 200);
      assert.equal(await amb.gheDe(comGhe), amb.ghes.soldagem);
      const semGhe = await amb.legado({ gheId: null });
      assert.equal((await alterar(semGhe, { setor: 'Outro' })).status, 200);
      assert.equal(await amb.gheDe(semGhe), null);
    });

    test('quem está vinculado a um GHE depois inativado continua editável e consultável; reenviar o mesmo GHE inativo não é troca', async () => {
      const id = await amb.legado({ gheId: amb.ghes.encerrado });
      const consulta = await amb.comoFixo(amb.usuarios.master).get(`/api/funcionarios/${id}`);
      assert.equal(consulta.status, 200, JSON.stringify(consulta.body));
      assert.equal(consulta.body.funcionario.grupoHomogeneo?.id, amb.ghes.encerrado);
      assert.equal((await alterar(id, { setor: 'Outro' })).status, 200);
      const mesmo = await alterar(id, { grupoHomogeneoId: amb.ghes.encerrado, funcao: 'Outra' });
      assert.equal(mesmo.status, 200, JSON.stringify(mesmo.body));
      assert.equal(await amb.gheDe(id), amb.ghes.encerrado);
    });

    test('isolamento: GHE de outra empresa e GHE inativo como destino de troca continuam recusados', async () => {
      const id = await completo();
      const antes = await amb.linha(id);
      const outraEmpresa = await alterar(id, { grupoHomogeneoId: amb.ghes.outraEmpresa });
      assert.deepEqual([outraEmpresa.status, outraEmpresa.body.codigo], [400, 'FUNCIONARIO_GHE_INVALIDO']);
      const inativo = await alterar(id, { grupoHomogeneoId: amb.ghes.encerrado });
      assert.deepEqual([inativo.status, inativo.body.codigo], [409, 'FUNCIONARIO_GHE_INATIVO']);
      assert.deepEqual(await amb.linha(id), antes);
    });
  });
});
