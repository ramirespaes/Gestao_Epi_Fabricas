'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteCadastro, HOJE, AMANHA } = require('./helpers/ambiente-funcionario-cadastro');

/**
 * S4 (RED) — regras de data do funcionário (campos da API: dataNascimento e dataAdmissao), no cadastro e na edição.
 *
 * Regras (data civil, relógio fixo injetado: "hoje" = 2026-10-10, enquanto a data UTC do instante já é 2026-10-11):
 *   - dataNascimento: opcional; data real; >= 1900-01-01 (inclusivo); estritamente anterior a hoje;
 *   - dataAdmissao: obrigatória no cadastro; data real; <= hoje (hoje vale); estritamente posterior ao nascimento, se houver;
 *   - PATCH parcial: as regras valem sobre o ESTADO FINAL (persistido + o enviado); omitido preserva; rejeição não grava nada.
 *
 * Códigos: o da admissão é o existente (400 FUNCIONARIO_DATA_ADMISSAO_INVALIDA). Para o nascimento fora da regra nova não há código
 * aprovado: os testes exigem 400 e a ausência de efeitos, sem fixar um código novo (proposta no relatório do RED).
 */

describe('S4 — datas do funcionário', () => {
  let amb;
  before(async () => { amb = await montarAmbienteCadastro(); });
  after(async () => { if (amb) await amb.encerrar(); });

  const criar = (extra) => amb.comoFixo(amb.usuarios.master).post('/api/funcionarios', amb.corpoValido(extra));
  const alterar = (id, corpo) => amb.comoFixo(amb.usuarios.master).patch(`/api/funcionarios/${id}`, corpo);
  const CODIGO_ADMISSAO = 'FUNCIONARIO_DATA_ADMISSAO_INVALIDA';

  describe('cadastro — casos válidos', () => {
    test('A/D. nascimento passado e admissão posterior ao nascimento', async () => {
      const r = await criar({ dataNascimento: '1995-05-15', dataAdmissao: '2013-05-15' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.deepEqual([r.body.funcionario.dataNascimento, r.body.funcionario.dataAdmissao], ['1995-05-15', '2013-05-15']);
    });

    test('B. nascimento exatamente em 1900-01-01 (limite inclusivo)', async () => {
      const r = await criar({ dataNascimento: '1900-01-01', dataAdmissao: '2026-01-15' });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.funcionario.dataNascimento, '1900-01-01');
    });

    test('C. admissão exatamente na data atual (data civil, mesmo com a data UTC já no dia seguinte)', async () => {
      const r = await criar({ dataAdmissao: HOJE });
      assert.equal(r.status, 201, JSON.stringify(r.body));
      assert.equal(r.body.funcionario.dataAdmissao, HOJE);
    });

    test('nascimento no dia anterior a hoje é válido (estritamente anterior)', async () => {
      const r = await criar({ dataNascimento: '2026-10-09', dataAdmissao: HOJE });
      assert.equal(r.status, 201, JSON.stringify(r.body));
    });
  });

  describe('cadastro — casos inválidos (400, nada gravado)', () => {
    const recusado = async (extra, codigo) => {
      const antes = await amb.total();
      const r = await criar(extra);
      assert.equal(r.status, 400, `${JSON.stringify(extra)} => ${JSON.stringify(r.body)}`);
      if (codigo !== undefined) assert.equal(r.body.codigo, codigo, JSON.stringify(r.body));
      assert.ok(typeof r.body.codigo === 'string' && r.body.codigo.length > 0);
      assert.equal(await amb.total(), antes, JSON.stringify(extra));
    };

    test('E. nascimento anterior a 1900-01-01', async () => {
      await recusado({ dataNascimento: '1899-12-31' });
    });

    // Com a admissão obrigatória e <= hoje, nascimento >= hoje também viola a relação nascimento × admissão; a regra isolada do
    // nascimento é provada na edição (5.7), com o legado sem admissão.
    test('F. nascimento hoje; G. nascimento futuro (amanhã, e longe no futuro)', async () => {
      await recusado({ dataNascimento: HOJE });
      await recusado({ dataNascimento: AMANHA });
      await recusado({ dataNascimento: '2999-01-01' });
    });

    test('H. admissão futura (amanhã, mesmo que a data UTC do instante já seja esse dia)', async () => {
      await recusado({ dataAdmissao: AMANHA }, CODIGO_ADMISSAO);
      await recusado({ dataAdmissao: '2999-01-01' }, CODIGO_ADMISSAO);
    });

    test('I. admissão anterior ao nascimento; J. admissão igual ao nascimento', async () => {
      await recusado({ dataNascimento: '2000-06-01', dataAdmissao: '1999-12-31' }, CODIGO_ADMISSAO);
      await recusado({ dataNascimento: '2000-06-01', dataAdmissao: '2000-06-01' }, CODIGO_ADMISSAO);
    });

    test('admissão anterior a 1900 continua recusada', async () => {
      await recusado({ dataAdmissao: '1899-12-31' }, CODIGO_ADMISSAO);
    });

    test('K. datas que não existem no calendário ou fora do formato ISO, nos dois campos', async () => {
      for (const invalida of ['2026-02-30', '2026-13-01', '2026-00-10', '2026-10-32', '2026-2-3', '10/10/2026', 'amanha', '']) {
        // eslint-disable-next-line no-await-in-loop
        await recusado({ dataNascimento: invalida, dataAdmissao: '2026-01-15' }, 'VALIDACAO');
        // eslint-disable-next-line no-await-in-loop
        await recusado({ dataAdmissao: invalida }, 'VALIDACAO');
      }
    });
  });

  describe('edição — validação pelo estado final', () => {
    const persistido = () => amb.legado({ dataNascimento: '1990-01-01', dataAdmissao: '2020-06-01' });

    test('5.1 só dataNascimento: comparada com a admissão já gravada', async () => {
      const id = await persistido();
      for (const nascimento of ['2020-06-01', '2021-01-01']) {
        // eslint-disable-next-line no-await-in-loop
        const r = await alterar(id, { dataNascimento: nascimento });
        assert.deepEqual([r.status, r.body.codigo], [400, CODIGO_ADMISSAO], nascimento);
      }
      const ok = await alterar(id, { dataNascimento: '2019-12-31' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual([ok.body.funcionario.dataNascimento, ok.body.funcionario.dataAdmissao], ['2019-12-31', '2020-06-01']);
    });

    test('5.2 só dataAdmissao: comparada com o nascimento já gravado', async () => {
      const id = await persistido();
      for (const admissao of ['1990-01-01', '1989-12-31']) {
        // eslint-disable-next-line no-await-in-loop
        const r = await alterar(id, { dataAdmissao: admissao });
        assert.deepEqual([r.status, r.body.codigo], [400, CODIGO_ADMISSAO], admissao);
      }
      const ok = await alterar(id, { dataAdmissao: '1990-01-02' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual([ok.body.funcionario.dataNascimento, ok.body.funcionario.dataAdmissao], ['1990-01-01', '1990-01-02']);
    });

    test('5.3 as duas no mesmo PATCH: vale a combinação final, não cada uma contra o gravado', async () => {
      const id = await persistido();
      // Isoladas contra o gravado seriam inválidas (nascimento 2022 > admissão gravada 2020); juntas formam um par válido.
      const par = await alterar(id, { dataNascimento: '2022-01-01', dataAdmissao: '2023-01-01' });
      assert.equal(par.status, 200, JSON.stringify(par.body));
      assert.deepEqual([par.body.funcionario.dataNascimento, par.body.funcionario.dataAdmissao], ['2022-01-01', '2023-01-01']);
      // Combinação final inválida: admissão <= nascimento.
      const antes = await amb.linha(id);
      const ruim = await alterar(id, { dataNascimento: '2024-01-01', dataAdmissao: '2024-01-01' });
      assert.deepEqual([ruim.status, ruim.body.codigo], [400, CODIGO_ADMISSAO]);
      assert.deepEqual(await amb.linha(id), antes);
    });

    test('limites no PATCH: nascimento 1900-01-01 e admissão hoje valem; nascimento hoje/amanhã/1899 e admissão amanhã não', async () => {
      const id = await persistido();
      for (const corpo of [{ dataNascimento: HOJE }, { dataNascimento: AMANHA }, { dataNascimento: '1899-12-31' }, { dataAdmissao: AMANHA }]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await alterar(id, corpo);
        assert.equal(r.status, 400, JSON.stringify(corpo));
      }
      const nascimento = await alterar(id, { dataNascimento: '1900-01-01' });
      assert.equal(nascimento.status, 200, JSON.stringify(nascimento.body));
      const admissao = await alterar(id, { dataAdmissao: HOJE });
      assert.equal(admissao.status, 200, JSON.stringify(admissao.body));
      assert.equal(admissao.body.funcionario.dataAdmissao, HOJE);
    });

    test('5.7 regra própria do nascimento, isolada da admissão (legado sem admissão): hoje, futuro e antes de 1900 são recusados; 1900-01-01 vale', async () => {
      // No cadastro a admissão é obrigatória e <= hoje, então nascimento >= hoje já cairia na regra de relação; aqui, sem admissão
      // gravada, só a regra do próprio nascimento decide.
      const id = await amb.legado();
      const antes = await amb.linha(id);
      for (const nascimento of [HOJE, AMANHA, '2999-01-01', '1899-12-31']) {
        // eslint-disable-next-line no-await-in-loop
        const r = await alterar(id, { dataNascimento: nascimento });
        assert.equal(r.status, 400, `${nascimento}: ${JSON.stringify(r.body)}`);
        // eslint-disable-next-line no-await-in-loop
        assert.deepEqual(await amb.linha(id), antes, nascimento);
      }
      const valido = await alterar(id, { dataNascimento: '1900-01-01' });
      assert.equal(valido.status, 200, JSON.stringify(valido.body));
      assert.equal(valido.body.funcionario.dataNascimento, '1900-01-01');
    });

    test('5.4 omitir as duas datas preserva exatamente os valores gravados', async () => {
      const id = await persistido();
      const antes = await amb.linha(id);
      const r = await alterar(id, { setor: 'Almoxarifado' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const depois = await amb.linha(id);
      assert.deepEqual([depois.data_nascimento, depois.data_admissao], [antes.data_nascimento, antes.data_admissao]);
      assert.equal(depois.setor, 'Almoxarifado');
    });

    test('5.5 legado sem nascimento (e sem admissão) segue editável nos outros campos, sem preenchimento retroativo', async () => {
      const semNascimento = await amb.legado({ dataAdmissao: '2020-06-01' });
      const r1 = await alterar(semNascimento, { funcao: 'Operador' });
      assert.equal(r1.status, 200, JSON.stringify(r1.body));
      assert.equal(r1.body.funcionario.dataNascimento, null);
      const semNada = await amb.legado();
      const r2 = await alterar(semNada, { setor: 'Expedição' });
      assert.equal(r2.status, 200, JSON.stringify(r2.body));
      assert.deepEqual([r2.body.funcionario.dataNascimento, r2.body.funcionario.dataAdmissao], [null, null]);
    });

    test('5.6 data inválida recusa o PATCH inteiro: nenhum outro campo é gravado e nenhuma auditoria de alteração nasce', async () => {
      const id = await persistido();
      const antes = await amb.linha(id);
      const eventosAntes = await amb.eventosDe(id);
      for (const corpo of [
        { setor: 'Mudou', dataNascimento: HOJE },
        { funcao: 'Mudou', dataAdmissao: AMANHA },
        { telefone: '47988880002', dataNascimento: '1899-12-31' },
        { setor: 'Mudou', dataNascimento: '2021-01-01' },
      ]) {
        // eslint-disable-next-line no-await-in-loop
        const r = await alterar(id, corpo);
        assert.equal(r.status, 400, JSON.stringify(corpo));
        // eslint-disable-next-line no-await-in-loop
        assert.deepEqual(await amb.linha(id), antes, `nada deveria mudar: ${JSON.stringify(corpo)}`);
      }
      assert.deepEqual(await amb.eventosDe(id), eventosAntes);
    });
  });
});
