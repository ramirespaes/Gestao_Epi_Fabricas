'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteSituacaoDatas } = require('./helpers/ambiente-funcionario-situacao-datas');

/**
 * Desligamento e afastamento × entregas de EPI (D1 e D3; RED; PostgreSQL real). NÃO EXECUTADO na rodada do RED por restrição
 * operacional (sem PostgreSQL).
 *
 * Regra: existindo entrega com data_operacional (data civil gravada, São Paulo) ESTRITAMENTE posterior à data efetiva informada,
 * a operação é recusada com 409 (DESLIGAMENTO_ANTERIOR_A_ENTREGA ou AFASTAMENTO_ANTERIOR_A_ENTREGA), sem confirmação de conflito.
 * Entrega no mesmo dia não bloqueia nem avisa. A recusa não altera a situação, o histórico nem as entregas. O erro traz só
 * contagem e datas civis. Retorno e reativação não consultam entregas.
 */

const ROTA = (id) => `/api/funcionarios/${id}/situacao`;

describe('situação × entregas (HTTP + PostgreSQL)', () => {
  let amb;
  before(async () => { amb = await montarAmbienteSituacaoDatas(); });
  after(async () => { if (amb) await amb.encerrar(); });

  const master = () => amb.usuarios.master;
  const mudar = (id, corpo, usuario = master()) => amb.como(usuario).post(ROTA(id), corpo);
  const intactoApos = async (id, acao) => {
    const antes = { f: await amb.ler(id), e: await amb.fotografiaDeEntregas(id) };
    const r = await acao();
    assert.deepEqual(await amb.ler(id), antes.f, 'o funcionário não pode mudar');
    assert.equal(await amb.fotografiaDeEntregas(id), antes.e, 'as entregas anteriores ficam byte a byte iguais');
    assert.deepEqual(await amb.historico(id), [], 'nenhuma linha de histórico');
    return r;
  };

  describe('desligamento (ATIVO → INATIVO e AFASTADO → INATIVO)', () => {
    test('entrega em data posterior à data efetiva: 409 DESLIGAMENTO_ANTERIOR_A_ENTREGA com contagem e datas civis, nada alterado', async () => {
      const id = await amb.trabalhador();
      await amb.entregar(id, '2026-10-05');
      await amb.entregar(id, '2026-10-08');
      const r = await intactoApos(id, () => mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-04' }));
      assert.deepEqual([r.status, r.body.codigo], [409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA'], JSON.stringify(r.body));
      assert.deepEqual(r.body.detalhes, { entregasPosteriores: 2, primeiraEntregaEm: '2026-10-05', ultimaEntregaEm: '2026-10-08' });
      assert.equal(JSON.stringify(r.body).includes('Luva'), false, 'sem material, quantidade ou pessoa no erro');
    });

    test('entrega no MESMO dia da data efetiva não bloqueia (a data não tem horário)', async () => {
      const id = await amb.trabalhador();
      await amb.entregar(id, '2026-10-05');
      const r = await mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-05' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.detalhes, undefined, 'e sem aviso adicional');
      assert.equal((await amb.ler(id)).situacao, 'INATIVO');
    });

    test('entrega anterior à data efetiva também não bloqueia', async () => {
      const id = await amb.trabalhador();
      await amb.entregar(id, '2026-10-03');
      assert.equal((await mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-05' })).status, 200);
    });

    test('só a mais recente decide: uma entrega antiga e uma posterior ainda conflitam', async () => {
      const id = await amb.trabalhador();
      await amb.entregar(id, '2026-09-01');
      await amb.entregar(id, '2026-10-09');
      const r = await intactoApos(id, () => mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' }));
      assert.deepEqual([r.status, r.body.codigo], [409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA']);
      assert.deepEqual(r.body.detalhes, { entregasPosteriores: 1, primeiraEntregaEm: '2026-10-09', ultimaEntregaEm: '2026-10-09' });
    });

    test('fuso: entrega às 23:30 de São Paulo (02:30 UTC do dia seguinte) vale pelo dia civil de São Paulo, nos dois sentidos', async () => {
      const id = await amb.trabalhador();
      await amb.entregar(id, '2026-10-05', '23:30:00');
      const mesmoDia = await mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-05' });
      assert.equal(mesmoDia.status, 200, 'o dia civil é 05; comparar a data UTC (06) recusaria indevidamente');
      const outro = await amb.trabalhador();
      await amb.entregar(outro, '2026-10-05', '23:30:00');
      const dia4 = await intactoApos(outro, () => mudar(outro, { situacao: 'INATIVO', dataEfetiva: '2026-10-04' }));
      assert.deepEqual([dia4.status, dia4.body.codigo], [409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA']);
      assert.equal(dia4.body.detalhes.primeiraEntregaEm, '2026-10-05');
    });

    test('quem está AFASTADO também respeita as entregas ao ser desligado (entrega registrada depois do início do afastamento, como pode existir em dado legado)', async () => {
      const id = await amb.trabalhador();
      assert.equal((await mudar(id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-03' })).status, 200);
      await amb.entregar(id, '2026-10-04');
      const antes = await amb.historico(id);
      const r = await mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-03' });
      assert.deepEqual([r.status, r.body.codigo], [409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA'], JSON.stringify(r.body));
      assert.equal((await amb.ler(id)).situacao, 'AFASTADO');
      assert.equal((await amb.historico(id)).length, antes.length);
      const mesmoDia = await mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-04' });
      assert.equal(mesmoDia.status, 200, 'no dia da entrega o desligamento é aceito');
    });

    test('a cronologia é decidida antes das entregas: um único conflito é informado', async () => {
      const id = await amb.trabalhador();
      await amb.entregar(id, '2026-10-08');
      assert.equal((await mudar(id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-09' })).status, 200);
      const r = await mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-07' });
      assert.deepEqual([r.status, r.body.codigo], [409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA']);
    });
  });

  describe('afastamento (ATIVO → AFASTADO)', () => {
    test('entrega em data posterior à data efetiva: 409 AFASTAMENTO_ANTERIOR_A_ENTREGA, sem confirmação de conflito, nada alterado', async () => {
      const id = await amb.trabalhador();
      await amb.entregar(id, '2026-10-06');
      const r = await intactoApos(id, () => mudar(id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' }));
      assert.deepEqual([r.status, r.body.codigo], [409, 'AFASTAMENTO_ANTERIOR_A_ENTREGA'], JSON.stringify(r.body));
      assert.deepEqual(r.body.detalhes, { entregasPosteriores: 1, primeiraEntregaEm: '2026-10-06', ultimaEntregaEm: '2026-10-06' });
    });

    test('não existe caminho de ciência: reconheceConflito é campo desconhecido (400) e o conflito continua recusado', async () => {
      const id = await amb.trabalhador();
      await amb.entregar(id, '2026-10-06');
      const r = await mudar(id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01', reconheceConflito: true });
      assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO']);
      const semCampo = await mudar(id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' });
      assert.equal(semCampo.status, 409);
      assert.deepEqual(await amb.historico(id), []);
    });

    test('entrega no mesmo dia do início do afastamento não bloqueia nem avisa', async () => {
      const id = await amb.trabalhador();
      await amb.entregar(id, '2026-10-06');
      const r = await mudar(id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-06' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.detalhes, undefined);
    });
  });

  describe('o que não conta', () => {
    test('entregas de OUTRO funcionário da mesma empresa não conflitam', async () => {
      const a = await amb.trabalhador();
      const b = await amb.trabalhador();
      await amb.entregar(b, '2026-10-09');
      assert.equal((await mudar(a, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' })).status, 200);
    });

    test('entregas de outra EMPRESA não conflitam, nem vazam por contagem', async () => {
      const a = await amb.trabalhador();
      const deB = await amb.trabalhador({ empresaId: amb.d.empresaB });
      await amb.entregar(deB, '2026-10-09');
      assert.equal((await mudar(a, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' })).status, 200);
      const recusado = await mudar(deB, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' }, amb.usuarios.masterB);
      assert.deepEqual([recusado.status, recusado.body.codigo], [409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA']);
      assert.equal(recusado.body.detalhes.entregasPosteriores, 1);
    });

    test('retorno e reativação não consultam entregas: AFASTADO → ATIVO e INATIVO → ATIVO seguem a cronologia, não as entregas', async () => {
      const id = await amb.trabalhador();
      await amb.entregar(id, '2026-10-01');
      assert.equal((await mudar(id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-02' })).status, 200);
      assert.equal((await mudar(id, { situacao: 'ATIVO', dataEfetiva: '2026-10-03' })).status, 200);
      const inativo = await amb.trabalhador({ situacao: 'INATIVO' });
      await amb.entregar(inativo, '2026-10-09');
      assert.equal((await mudar(inativo, { situacao: 'ATIVO' })).status, 200);
    });
  });

  describe('auditoria da recusa (D4)', () => {
    test('a recusa por entrega é auditada com código técnico, ator e empresa, sem datas nem conteúdo; a transação principal é desfeita', async () => {
      const id = await amb.trabalhador();
      await amb.entregar(id, '2026-10-05');
      const r = await mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' });
      assert.equal(r.status, 409);
      const recusas = await amb.auditoria('FUNCIONARIO_SITUACAO_RECUSADA', id);
      assert.equal(recusas.length, 1);
      const [recusa] = recusas;
      assert.deepEqual(recusa.contexto, { operacao: 'INATIVAR', codigo: 'DESLIGAMENTO_ANTERIOR_A_ENTREGA' });
      assert.equal(recusa.usuario_id, master());
      assert.equal(recusa.empresa_id, amb.d.empresaA);
      const texto = JSON.stringify([recusa.contexto, recusa.dados_anteriores, recusa.dados_novos]);
      for (const proibido of ['2026-10-01', '2026-10-05', 'dataEfetiva', 'Luva']) assert.equal(texto.includes(proibido), false, proibido);
      assert.deepEqual(await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', id), [], 'nenhuma auditoria de sucesso');
      assert.deepEqual(await amb.historico(id), []);
    });

    test('a recusa de afastamento por entrega é auditada como AFASTAR', async () => {
      const id = await amb.trabalhador();
      await amb.entregar(id, '2026-10-05');
      await mudar(id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' });
      const [recusa] = await amb.auditoria('FUNCIONARIO_SITUACAO_RECUSADA', id);
      assert.deepEqual(recusa.contexto, { operacao: 'AFASTAR', codigo: 'AFASTAMENTO_ANTERIOR_A_ENTREGA' });
    });
  });
});
