'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteCadastro } = require('./helpers/ambiente-funcionario-cadastro');
const { comMascara } = require('../helpers/cpf-ficticio');

/**
 * S4 (RED) — cadastro individual: `POST /api/funcionarios`.
 *
 * Contrato novo: OBRIGATÓRIOS nome, cpf, setor, funcao, grupoHomogeneoId (GHE existente, ativo e da empresa) e
 * dataAdmissao; OPCIONAIS matricula (nunca gerada, nunca o CPF), telefone e dataNascimento. O funcionário nasce ATIVO
 * (situacao 'ATIVO', ativo true) e o cliente não define situacao nem ativo. Importação em lote NÃO muda (guardas separados).
 * Datas: arquivo \`funcionario-cadastro-datas\`.
 *
 * Os campos do JSON são os da API (camelCase). Toda falha é de regra ainda ausente, nunca de harness.
 */

describe('S4 — cadastro individual (POST /funcionarios)', () => {
  let amb;
  before(async () => { amb = await montarAmbienteCadastro(); });
  after(async () => { if (amb) await amb.encerrar(); });

  const criar = (corpo, usuario = amb.usuarios.master) => amb.comoFixo(usuario).post('/api/funcionarios', corpo);
  const recusado = async (corpo, campo, codigo) => {
    const antes = await amb.total();
    const eventosAntes = await amb.eventosTotal('FUNCIONARIO_CRIADO');
    const r = await criar(corpo);
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.equal(r.body.codigo, codigo ?? 'VALIDACAO', JSON.stringify(r.body));
    if (campo !== undefined) assert.ok((r.body.detalhes ?? []).some((d) => d.campo === campo), `detalhe de ${campo}: ${JSON.stringify(r.body.detalhes)}`);
    assert.equal(await amb.total(), antes, 'nada deveria ser gravado');
    assert.equal(await amb.eventosTotal('FUNCIONARIO_CRIADO'), eventosAntes, 'nenhuma auditoria de criação');
  };

  describe('cadastro válido', () => {
    test('201 com os obrigatórios; nasce ATIVO (situacao e ativo), com GHE, setor, função e admissão gravados', async () => {
      const corpo = amb.corpoValido();
      const r = await criar(corpo);
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const f = r.body.funcionario;
      assert.equal(f.situacao, 'ATIVO');
      assert.equal(f.ativo, true);
      assert.equal(f.grupoHomogeneoId, amb.ghes.soldagem);
      assert.deepEqual(f.grupoHomogeneo, { id: amb.ghes.soldagem, codigo: 'GHE-020', descricao: 'Soldagem' });
      assert.deepEqual([f.setor, f.funcao, f.dataAdmissao, f.matricula, f.dataNascimento], ['Manutenção', 'Mecânico', '2026-01-15', corpo.matricula, null]);
      assert.equal(f.cpf, undefined);
      const gravada = await amb.linha(f.id);
      assert.deepEqual([gravada.situacao, gravada.ativo, gravada.empresa_id], ['ATIVO', true, amb.d.empresaA]);
    });

    test('auditoria de criação preservada: FUNCIONARIO_CRIADO com o ator, sem CPF, telefone nem nascimento', async () => {
      const r = await criar(amb.corpoValido({ telefone: '47988880000', dataNascimento: '1990-03-15' }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      const { rows } = await amb.pool.query("SELECT usuario_id, empresa_id, contexto, dados_novos FROM logs_auditoria WHERE acao = 'FUNCIONARIO_CRIADO' AND referencia = $1", [String(r.body.funcionario.id)]);
      assert.equal(rows.length, 1);
      assert.deepEqual([rows[0].usuario_id, rows[0].empresa_id], [amb.usuarios.master, amb.d.empresaA]);
      const texto = JSON.stringify(rows[0]);
      for (const proibido of ['47988880000', '1990-03-15']) assert.equal(texto.includes(proibido), false, proibido);
    });

    test('opcionais ausentes: matrícula, telefone e nascimento nulos (matrícula nunca gerada nem copiada do CPF); dois sem matrícula convivem', async () => {
      const a = await criar(amb.corpoValido({ matricula: undefined }));
      const b = await criar(amb.corpoValido({ matricula: undefined }));
      for (const r of [a, b]) {
        assert.equal(r.status, 201, JSON.stringify(r.body));
        assert.deepEqual([r.body.funcionario.matricula, r.body.funcionario.telefone, r.body.funcionario.dataNascimento], [null, null, null]);
      }
      const gravada = await amb.linha(a.body.funcionario.id);
      assert.equal(gravada.matricula, null);
      assert.notEqual(gravada.matricula, gravada.cpf);
    });

    test('opcionais informados são gravados (telefone, nascimento, matrícula)', async () => {
      const r = await criar(amb.corpoValido({ telefone: '47988880001', dataNascimento: '1990-03-15', matricula: 'MAT-OPC-1' }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual([r.body.funcionario.telefone, r.body.funcionario.dataNascimento, r.body.funcionario.matricula], ['47988880001', '1990-03-15', 'MAT-OPC-1']);
    });

    test('CPF com máscara é aceito e gravado só com dígitos', async () => {
      const corpo = amb.corpoValido();
      const r = await criar({ ...corpo, cpf: comMascara(corpo.cpf) });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal((await amb.linha(r.body.funcionario.id)).cpf, corpo.cpf);
    });

    test('sem employeeHistory.criar (só visualizar ou só editar): 403 e nada é gravado', async () => {
      const antes = await amb.total();
      const semCriar = await criar(amb.corpoValido(), amb.usuarios.soVisualizar);
      assert.equal(semCriar.status, 403);
      assert.equal((await criar(amb.corpoValido(), amb.usuarios.comEditar)).status, 403);
      assert.equal(await amb.total(), antes);
    });
  });

  describe('obrigatórios: a ausência de cada um é recusada (400 VALIDACAO) e nada é gravado', () => {
    for (const campo of ['nome', 'cpf', 'setor', 'funcao', 'grupoHomogeneoId', 'dataAdmissao']) {
      test(`sem ${campo}`, async () => {
        await recusado(amb.corpoValido({ [campo]: undefined }), `body.${campo}`);
      });
    }

    test('nulo explícito ou vazio nos obrigatórios também é recusado', async () => {
      for (const [campo, valor] of [['setor', null], ['funcao', null], ['grupoHomogeneoId', null], ['dataAdmissao', null], ['setor', '   '], ['funcao', ''], ['nome', '  ']]) {
        // eslint-disable-next-line no-await-in-loop
        await recusado(amb.corpoValido({ [campo]: valor }), `body.${campo}`);
      }
    });
  });

  describe('CPF', () => {
    test('CPF com dígito verificador inválido: 400 VALIDACAO CPF_DV_INVALIDO', async () => {
      const antes = await amb.total();
      const r = await criar(amb.corpoValido({ cpf: '529.982.247-26' }));
      assert.equal(r.status, 400);
      assert.ok(r.body.detalhes.some((d) => d.campo === 'body.cpf' && d.codigo === 'CPF_DV_INVALIDO'));
      assert.equal(await amb.total(), antes);
    });

    test('CPF repetido na empresa: 409 FUNCIONARIO_CPF_EM_USO; o mesmo CPF em outra empresa é aceito', async () => {
      const corpo = amb.corpoValido();
      assert.equal((await criar(corpo)).status, 201);
      const repetido = await criar({ ...corpo, matricula: 'OUTRA-1' });
      assert.deepEqual([repetido.status, repetido.body.codigo], [409, 'FUNCIONARIO_CPF_EM_USO']);
      const deB = await amb.comoFixo(amb.usuarios.masterB).post('/api/funcionarios', { ...corpo, matricula: 'B-1', grupoHomogeneoId: amb.ghes.outraEmpresa });
      assert.equal(deB.status, 201, JSON.stringify(deB.body));
    });

    test('matrícula preenchida continua única na empresa: 409 FUNCIONARIO_MATRICULA_EM_USO', async () => {
      const primeira = amb.corpoValido({ matricula: 'UNICA-S4' });
      assert.equal((await criar(primeira)).status, 201);
      const segunda = await criar(amb.corpoValido({ matricula: 'UNICA-S4' }));
      assert.deepEqual([segunda.status, segunda.body.codigo], [409, 'FUNCIONARIO_MATRICULA_EM_USO']);
    });

    test('telefone acima do limite (21 caracteres) continua recusado', async () => {
      await recusado(amb.corpoValido({ telefone: '1'.repeat(21) }), 'body.telefone');
    });
  });

  describe('situação e ativo não são do cliente', () => {
    test('enviar situacao, ativo ou qualquer campo estranho no cadastro: 400 VALIDACAO pelo mecanismo comum, nada gravado', async () => {
      for (const extra of [{ situacao: 'ATIVO' }, { situacao: 'AFASTADO' }, { ativo: true }, { ativo: false }, { empresaId: 999 }]) {
        // eslint-disable-next-line no-await-in-loop
        await recusado(amb.corpoValido(extra));
      }
    });
  });

  describe('GHE do cadastro', () => {
    test('GHE inexistente ou de outra empresa: 400 FUNCIONARIO_GHE_INVALIDO; inativo: 409 FUNCIONARIO_GHE_INATIVO; nada gravado', async () => {
      const antes = await amb.total();
      for (const gheId of [999999, amb.ghes.outraEmpresa]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await criar(amb.corpoValido({ grupoHomogeneoId: gheId }));
        assert.deepEqual([r.status, r.body.codigo], [400, 'FUNCIONARIO_GHE_INVALIDO'], String(gheId));
      }
      const inativo = await criar(amb.corpoValido({ grupoHomogeneoId: amb.ghes.encerrado }));
      assert.deepEqual([inativo.status, inativo.body.codigo], [409, 'FUNCIONARIO_GHE_INATIVO']);
      assert.equal(await amb.total(), antes);
    });

    test('GHE legado (sem código) ativo da empresa é aceito', async () => {
      const r = await criar(amb.corpoValido({ grupoHomogeneoId: amb.ghes.legado }));
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.funcionario.grupoHomogeneo.codigo, null);
    });
  });
});
