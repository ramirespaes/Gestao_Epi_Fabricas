'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteSituacaoDatas, HOJE, AMANHA } = require('./helpers/ambiente-funcionario-situacao-datas');

/**
 * Datas efetivas da situação do funcionário — rotas, regras, histórico, auditoria e rotas legadas (RED; PostgreSQL real).
 * NÃO EXECUTADO na rodada do RED por restrição operacional (sem PostgreSQL, nem temporário). Relógio fixo: hoje = 2026-10-10
 * (a data UTC já é 2026-10-11).
 *
 * Contrato (especificação 02): INATIVO e AFASTADO exigem dataEfetiva; AFASTADO → ATIVO exige a data do retorno; INATIVO → ATIVO
 * não aceita data. Cada mudança grava uma linha imutável em funcionario_situacoes (ator da sessão, instante do servidor, data
 * efetiva separada). Erros: 400 para dado inválido (VALIDACAO com campo body.dataEfetiva, ou código próprio), 409 para estado,
 * cronologia ou entrega. Auditoria sem datas, vinculada à linha de histórico por identificador.
 */

const ROTA = (id) => `/api/funcionarios/${id}/situacao`;

describe('datas efetivas da situação (HTTP + PostgreSQL)', () => {
  let amb;
  before(async () => { amb = await montarAmbienteSituacaoDatas(); });
  after(async () => { if (amb) await amb.encerrar(); });

  const master = () => amb.usuarios.master;
  const mudar = (usuario, id, corpo) => amb.como(usuario).post(ROTA(id), corpo);
  const detalheDoCampo = (r, campo = 'body.dataEfetiva') => (r.body.detalhes ?? []).find((x) => x.campo === campo);
  const nada = async (id, antes) => {
    assert.deepEqual(await amb.ler(id), antes, 'o funcionário não pode mudar');
    assert.deepEqual(await amb.historico(id), [], 'nenhuma linha de histórico');
  };

  describe('as cinco transições com a data certa', () => {
    const CASOS = [
      ['ATIVO', 'INATIVO', { dataEfetiva: '2026-10-01' }],
      ['ATIVO', 'AFASTADO', { dataEfetiva: '2026-10-02' }],
      ['AFASTADO', 'INATIVO', { dataEfetiva: '2026-10-03' }],
      ['AFASTADO', 'ATIVO', { dataEfetiva: '2026-10-04' }],
      ['INATIVO', 'ATIVO', {}],
    ];
    for (const [de, para, extra] of CASOS) {
      test(`${de} → ${para}: 200, estado novo, uma linha de histórico com a data efetiva e o ator da sessão`, async () => {
        const id = await amb.trabalhador({ situacao: de });
        const r = await mudar(master(), id, { situacao: para, ...extra });
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.funcionario.situacao, para);
        const linhas = await amb.historico(id);
        assert.equal(linhas.length, 1);
        const [h] = linhas;
        assert.deepEqual([h.situacao_anterior, h.situacao_nova, h.data_efetiva ?? null], [de, para, extra.dataEfetiva ?? null]);
        assert.equal(h.registrado_por, master());
        assert.equal(h.empresa_id, amb.d.empresaA);
        assert.equal(h.funcionario_id, id);
        assert.equal(r.body.ultimaMudancaSituacao.situacao, para);
        assert.equal(r.body.ultimaMudancaSituacao.dataEfetiva ?? null, extra.dataEfetiva ?? null);
        assert.equal(new Date(r.body.ultimaMudancaSituacao.registradaEm).getTime(), new Date(h.registrado_em).getTime());
      });
    }

    test('a data efetiva é separada do instante da operação: o instante é do servidor e não depende da data informada', async () => {
      const id = await amb.trabalhador();
      await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: '2026-03-15' });
      const [h] = await amb.historico(id);
      assert.equal(h.data_efetiva, '2026-03-15');
      assert.ok(Math.abs(Date.now() - new Date(h.registrado_em).getTime()) < 120_000, 'registrado_em é o now() do servidor');
    });

    test('a resposta nunca traz o CPF completo', async () => {
      const id = await amb.trabalhador();
      const r = await mudar(master(), id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.funcionario.cpf, undefined);
      assert.match(r.body.funcionario.cpfMascarado ?? '', /^\*\*\*\.\*\*\*\.\*\*\*-\d{2}$/);
    });
  });

  describe('validação da entrada (400)', () => {
    for (const destino of ['INATIVO', 'AFASTADO']) {
      test(`${destino} sem dataEfetiva (ausente, null, vazia): 400 VALIDACAO apontando body.dataEfetiva; nada gravado`, async () => {
        const id = await amb.trabalhador();
        const antes = await amb.ler(id);
        for (const corpo of [{ situacao: destino }, { situacao: destino, dataEfetiva: null }, { situacao: destino, dataEfetiva: '' }]) {
          const r = await mudar(master(), id, corpo);
          assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
          assert.ok(detalheDoCampo(r), JSON.stringify(r.body.detalhes));
        }
        await nada(id, antes);
      });
    }

    test('formato ou calendário inválidos: 400 VALIDACAO com código DATA_EFETIVA_INVALIDA, sem eco do valor', async () => {
      const id = await amb.trabalhador();
      const antes = await amb.ler(id);
      for (const dataEfetiva of ['2026-02-30', '01/10/2026', '2026-13-01', 'ontem', 20261001]) {
        const r = await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva });
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], String(dataEfetiva));
        if (typeof dataEfetiva === 'string') assert.equal(JSON.stringify(r.body).includes(dataEfetiva), false, 'o valor recebido não volta');
      }
      const r = await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: '2026-02-30' });
      assert.equal(detalheDoCampo(r)?.codigo, 'DATA_EFETIVA_INVALIDA');
      await nada(id, antes);
    });

    test('data futura pela data CIVIL de São Paulo: 2026-10-11 é futura (400 DATA_EFETIVA_FUTURA) mesmo com a data UTC já nesse dia; 2026-10-10 vale', async () => {
      const id = await amb.trabalhador();
      const antes = await amb.ler(id);
      const futura = await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: AMANHA });
      assert.deepEqual([futura.status, futura.body.codigo], [400, 'DATA_EFETIVA_FUTURA']);
      await nada(id, antes);
      const hoje = await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: HOJE });
      assert.equal(hoje.status, 200, JSON.stringify(hoje.body));
      assert.equal((await amb.historico(id))[0].data_efetiva, HOJE);
    });

    test('anterior à admissão conhecida: 400 DATA_EFETIVA_ANTERIOR_A_ADMISSAO; no dia da admissão vale; sem admissão nada é exigido', async () => {
      const id = await amb.trabalhador({ admissao: '2026-03-01' });
      const antes = await amb.ler(id);
      const ruim = await mudar(master(), id, { situacao: 'AFASTADO', dataEfetiva: '2026-02-28' });
      assert.deepEqual([ruim.status, ruim.body.codigo], [400, 'DATA_EFETIVA_ANTERIOR_A_ADMISSAO']);
      await nada(id, antes);
      assert.equal((await mudar(master(), id, { situacao: 'AFASTADO', dataEfetiva: '2026-03-01' })).status, 200);
      const sem = await amb.trabalhador({ admissao: null });
      assert.equal((await mudar(master(), sem, { situacao: 'INATIVO', dataEfetiva: '1999-01-01' })).status, 200, 'legado sem admissão: nenhuma data é inventada');
    });

    test('AFASTADO → ATIVO sem data do retorno: 400 DATA_EFETIVA_OBRIGATORIA', async () => {
      const id = await amb.trabalhador({ situacao: 'AFASTADO' });
      const r = await mudar(master(), id, { situacao: 'ATIVO' });
      assert.deepEqual([r.status, r.body.codigo], [400, 'DATA_EFETIVA_OBRIGATORIA']);
      assert.equal((await amb.ler(id)).situacao, 'AFASTADO');
      assert.deepEqual(await amb.historico(id), []);
    });

    test('INATIVO → ATIVO com data: 400 DATA_EFETIVA_NAO_SE_APLICA (reativação não é retorno nem nova contratação)', async () => {
      const id = await amb.trabalhador({ situacao: 'INATIVO' });
      const r = await mudar(master(), id, { situacao: 'ATIVO', dataEfetiva: '2026-10-01' });
      assert.deepEqual([r.status, r.body.codigo], [400, 'DATA_EFETIVA_NAO_SE_APLICA']);
      assert.equal((await amb.ler(id)).situacao, 'INATIVO');
      assert.deepEqual(await amb.historico(id), []);
    });

    test('campos descartados e chaves do cliente: 400 VALIDACAO (motivo, descricao, previsaoRetorno, reconheceConflito, empresaId, atorId…)', async () => {
      const id = await amb.trabalhador();
      const antes = await amb.ler(id);
      for (const extra of [{ motivo: 'x' }, { descricao: 'x' }, { observacao: 'x' }, { previsaoRetorno: '2026-11-01' }, { reconheceConflito: true }, { empresaId: 999 }, { atorId: 1 }, { registradoEm: '2020-01-01' }, { cid: 'A00' }]) {
        const r = await mudar(master(), id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01', ...extra });
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(extra));
      }
      await nada(id, antes);
    });

    test('regras de estado anteriores: INATIVO → AFASTADO e a mesma situação continuam 409', async () => {
      const inativo = await amb.trabalhador({ situacao: 'INATIVO' });
      const r1 = await mudar(master(), inativo, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' });
      assert.deepEqual([r1.status, r1.body.codigo], [409, 'FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA']);
      const afastado = await amb.trabalhador({ situacao: 'AFASTADO' });
      const r2 = await mudar(master(), afastado, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' });
      assert.deepEqual([r2.status, r2.body.codigo], [409, 'FUNCIONARIO_SITUACAO_IGUAL']);
      assert.deepEqual([...(await amb.historico(inativo)), ...(await amb.historico(afastado))], []);
    });
  });

  describe('consistência cronológica e recontratação (409)', () => {
    test('cadeia completa: desligamento → reativação → afastamento → retorno → novo desligamento; datas incompatíveis são recusadas; histórico preservado', async () => {
      const id = await amb.trabalhador({ admissao: '2020-01-01' });
      const antes = await amb.ler(id);

      assert.equal((await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: '2026-09-01' })).status, 200);
      assert.equal((await mudar(master(), id, { situacao: 'ATIVO' })).status, 200, 'reativação sem data');
      const primeiraLinha = JSON.stringify((await amb.historico(id))[0]);

      const antigo = await mudar(master(), id, { situacao: 'AFASTADO', dataEfetiva: '2026-08-01' });
      assert.deepEqual([antigo.status, antigo.body.codigo], [409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA']);
      assert.equal(antigo.body.detalhes?.limite, '2026-09-01', 'o erro informa a data mínima aceita');
      assert.equal((await amb.ler(id)).situacao, 'ATIVO');

      assert.equal((await mudar(master(), id, { situacao: 'AFASTADO', dataEfetiva: '2026-09-01' })).status, 200, 'no mesmo dia da última data efetiva vale');

      const retornoAntes = await mudar(master(), id, { situacao: 'ATIVO', dataEfetiva: '2026-08-31' });
      assert.deepEqual([retornoAntes.status, retornoAntes.body.codigo], [409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA']);
      assert.equal(retornoAntes.body.detalhes?.limite, '2026-09-01');

      assert.equal((await mudar(master(), id, { situacao: 'ATIVO', dataEfetiva: '2026-09-15' })).status, 200);
      assert.equal((await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' })).status, 200);

      const linhas = await amb.historico(id);
      assert.deepEqual(linhas.map((h) => [h.situacao_anterior, h.situacao_nova, h.data_efetiva ?? null]), [
        ['ATIVO', 'INATIVO', '2026-09-01'],
        ['INATIVO', 'ATIVO', null],
        ['ATIVO', 'AFASTADO', '2026-09-01'],
        ['AFASTADO', 'ATIVO', '2026-09-15'],
        ['ATIVO', 'INATIVO', '2026-10-01'],
      ]);
      assert.equal(JSON.stringify(linhas[0]), primeiraLinha, 'a primeira linha nunca é reescrita');
      const depois = await amb.ler(id);
      for (const campo of ['cpf', 'matricula', 'nome', 'data_admissao', 'grupo_homogeneo_id', 'criado_em']) {
        assert.deepEqual(depois[campo], antes[campo], `${campo} preservado: reativar não é nova contratação`);
      }
    });

    test('desligamento de quem está AFASTADO não pode ser anterior ao início do afastamento', async () => {
      const id = await amb.trabalhador();
      assert.equal((await mudar(master(), id, { situacao: 'AFASTADO', dataEfetiva: '2026-09-10' })).status, 200);
      const r = await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: '2026-09-01' });
      assert.deepEqual([r.status, r.body.codigo], [409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA']);
      assert.equal((await amb.ler(id)).situacao, 'AFASTADO');
    });

    test('legado AFASTADO sem histórico: o retorno é aceito pela admissão, sem inventar início, e só a nova linha existe', async () => {
      const id = await amb.trabalhador({ situacao: 'AFASTADO', admissao: '2020-01-01' });
      assert.deepEqual(await amb.historico(id), [], 'o legado não ganha linha inventada');
      const antes = await mudar(master(), id, { situacao: 'ATIVO', dataEfetiva: '2019-12-31' });
      assert.deepEqual([antes.status, antes.body.codigo], [400, 'DATA_EFETIVA_ANTERIOR_A_ADMISSAO']);
      const ok = await mudar(master(), id, { situacao: 'ATIVO', dataEfetiva: '2026-10-05' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.deepEqual((await amb.historico(id)).map((h) => [h.situacao_anterior, h.situacao_nova, h.data_efetiva]), [['AFASTADO', 'ATIVO', '2026-10-05']]);
    });

    test('legado INATIVO sem histórico: a reativação não pede data e grava uma única linha com data nula; o desligamento nunca é presumido', async () => {
      const id = await amb.trabalhador({ situacao: 'INATIVO' });
      assert.deepEqual(await amb.historico(id), []);
      const r = await mudar(master(), id, { situacao: 'ATIVO' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual((await amb.historico(id)).map((h) => [h.situacao_anterior, h.situacao_nova, h.data_efetiva ?? null]), [['INATIVO', 'ATIVO', null]]);
    });
  });

  describe('rotas legadas inativar e reativar', () => {
    const legado = (id, rota, corpo = {}) => amb.como(master()).post(`/api/funcionarios/${id}/${rota}`, corpo);

    test('inativar sem dataEfetiva: 400 VALIDACAO, nada gravado (nenhuma rota inativa sem data)', async () => {
      const id = await amb.trabalhador();
      const antes = await amb.ler(id);
      for (const corpo of [{}, { dataEfetiva: null }, { motivo: 'x' }, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' }]) {
        const r = await legado(id, 'inativar', corpo);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
      }
      await nada(id, antes);
    });

    test('inativar com data: 200, alterado, mesmo histórico da rota de situação', async () => {
      const id = await amb.trabalhador();
      const r = await legado(id, 'inativar', { dataEfetiva: '2026-10-01' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.alterado, true);
      assert.equal(r.body.funcionario.situacao, 'INATIVO');
      assert.deepEqual((await amb.historico(id)).map((h) => [h.situacao_nova, h.data_efetiva]), [['INATIVO', '2026-10-01']]);
    });

    test('inativar AFASTADO com data: vai a INATIVO respeitando a cronologia', async () => {
      const id = await amb.trabalhador({ situacao: 'AFASTADO' });
      const r = await legado(id, 'inativar', { dataEfetiva: '2026-10-01' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.funcionario.situacao, 'INATIVO');
    });

    test('inativar quem já está INATIVO continua idempotente (com data): alterado false, sem linha nova e sem auditoria', async () => {
      const id = await amb.trabalhador({ situacao: 'INATIVO' });
      const r = await legado(id, 'inativar', { dataEfetiva: '2026-10-01' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.alterado, false);
      assert.deepEqual(await amb.historico(id), []);
      assert.deepEqual(await amb.acoes(id), []);
    });

    test('reativar INATIVO com corpo vazio continua igual: 200, ATIVO, linha com data nula; com data é 400', async () => {
      const id = await amb.trabalhador({ situacao: 'INATIVO' });
      const comData = await legado(id, 'reativar', { dataEfetiva: '2026-10-01' });
      assert.deepEqual([comData.status, comData.body.codigo], [400, 'DATA_EFETIVA_NAO_SE_APLICA']);
      const r = await legado(id, 'reativar');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.alterado, true);
      assert.equal(r.body.funcionario.situacao, 'ATIVO');
      assert.deepEqual((await amb.historico(id)).map((h) => h.data_efetiva ?? null), [null]);
    });

    test('reativar AFASTADO exige a data do retorno; com ela vai a ATIVO', async () => {
      const id = await amb.trabalhador({ situacao: 'AFASTADO' });
      const sem = await legado(id, 'reativar');
      assert.deepEqual([sem.status, sem.body.codigo], [400, 'DATA_EFETIVA_OBRIGATORIA']);
      const ok = await legado(id, 'reativar', { dataEfetiva: '2026-10-05' });
      assert.equal(ok.status, 200, JSON.stringify(ok.body));
      assert.equal(ok.body.funcionario.situacao, 'ATIVO');
    });

    test('reativar quem já está ATIVO continua idempotente: alterado false, sem linha nem auditoria', async () => {
      const id = await amb.trabalhador();
      const r = await legado(id, 'reativar');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.alterado, false);
      assert.deepEqual(await amb.historico(id), []);
      assert.deepEqual(await amb.acoes(id), []);
    });

    test('eventos legados de auditoria continuam: INATIVADO e REATIVADO só em ATIVO↔INATIVO', async () => {
      const a = await amb.trabalhador();
      await legado(a, 'inativar', { dataEfetiva: '2026-10-01' });
      assert.deepEqual((await amb.acoes(a)).sort(), ['FUNCIONARIO_INATIVADO', 'FUNCIONARIO_SITUACAO_ALTERADA']);
      const b = await amb.trabalhador({ situacao: 'AFASTADO' });
      await legado(b, 'reativar', { dataEfetiva: '2026-10-05' });
      assert.deepEqual(await amb.acoes(b), ['FUNCIONARIO_SITUACAO_ALTERADA']);
    });
  });

  describe('auditoria (D4)', () => {
    test('sucesso: operação e vínculo com a linha de histórico por identificador; nunca datas, motivo ou texto livre', async () => {
      const id = await amb.trabalhador();
      const r = await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [h] = await amb.historico(id);
      const [linha] = await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', id);
      assert.equal(linha.empresa_id, amb.d.empresaA);
      assert.equal(linha.usuario_id, master());
      assert.equal(linha.contexto.operacao, 'INATIVAR');
      assert.equal(String(linha.contexto.historicoId), String(h.id));
      assert.equal(linha.contexto.origem, 'GESTAO_FUNCIONARIOS');
      assert.deepEqual(linha.dados_anteriores, { situacao: 'ATIVO' });
      assert.deepEqual(linha.dados_novos, { situacao: 'INATIVO' });
      const linhasDeAuditoria = [...(await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', id)), ...(await amb.auditoria('FUNCIONARIO_INATIVADO', id))];
      assert.equal(linhasDeAuditoria.length, 2, 'o evento de situação e o legado ATIVO → INATIVO');
      const todas = JSON.stringify(linhasDeAuditoria.map((l) => [l.contexto, l.dados_anteriores, l.dados_novos]));
      for (const proibido of ['2026-10-01', '01/10/2026', 'dataEfetiva', 'motivo', 'descricao']) assert.equal(todas.includes(proibido), false, proibido);
    });

    test('a operação registrada acompanha a transição (INATIVAR, AFASTAR, ATIVAR)', async () => {
      const a = await amb.trabalhador();
      await mudar(master(), a, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' });
      assert.equal((await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', a))[0].contexto.operacao, 'AFASTAR');
      await mudar(master(), a, { situacao: 'ATIVO', dataEfetiva: '2026-10-02' });
      assert.equal((await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', a))[1].contexto.operacao, 'ATIVAR');
    });

    test('recusa 409 nova (cronologia): auditada com código técnico, ator e empresa, sem datas; a situação não muda', async () => {
      const id = await amb.trabalhador();
      await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: '2026-09-10' });
      await mudar(master(), id, { situacao: 'ATIVO' });
      const r = await mudar(master(), id, { situacao: 'AFASTADO', dataEfetiva: '2026-09-01' });
      assert.deepEqual([r.status, r.body.codigo], [409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA']);
      const [recusa] = await amb.auditoria('FUNCIONARIO_SITUACAO_RECUSADA', id);
      assert.ok(recusa, 'a recusa precisa ser auditada, mesmo com a transação desfeita');
      assert.equal(recusa.usuario_id, master());
      assert.equal(recusa.empresa_id, amb.d.empresaA);
      assert.deepEqual(recusa.contexto, { operacao: 'AFASTAR', codigo: 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA' });
      assert.equal(JSON.stringify(recusa).includes('2026-09'), false);
      assert.equal((await amb.ler(id)).situacao, 'ATIVO');
    });

    test('validação 400 e os 409 já existentes (igual, transição) não geram FUNCIONARIO_SITUACAO_RECUSADA', async () => {
      const id = await amb.trabalhador({ situacao: 'INATIVO' });
      await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: '2026-10-01' });
      await mudar(master(), id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' });
      await mudar(master(), id, { situacao: 'ATIVO', dataEfetiva: '2026-10-01' });
      await mudar(master(), id, { situacao: 'INATIVO' });
      assert.deepEqual(await amb.auditoria('FUNCIONARIO_SITUACAO_RECUSADA', id), []);
      assert.deepEqual(await amb.acoes(id), []);
    });
  });

  describe('autorização, sessão e isolamento multiempresa', () => {
    test('sem sessão: 401; sem permissão ou só visualizar: 403; nada gravado', async () => {
      const id = await amb.trabalhador();
      const antes = await amb.ler(id);
      const corpo = { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' };
      assert.equal((await amb.anonimo.post(ROTA(id), corpo)).status, 401);
      assert.equal((await mudar(amb.usuarios.semPermissao, id, corpo)).status, 403);
      assert.equal((await mudar(amb.usuarios.soVisualizar, id, corpo)).status, 403);
      for (const rota of ['inativar', 'reativar']) {
        assert.equal((await amb.como(amb.usuarios.soVisualizar).post(`/api/funcionarios/${id}/${rota}`, { dataEfetiva: '2026-10-01' })).status, 403, rota);
      }
      await nada(id, antes);
    });

    test('com employeeHistory.editar a mudança é aceita e o ator gravado é o da sessão', async () => {
      const id = await amb.trabalhador();
      const r = await mudar(amb.usuarios.comEditar, id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal((await amb.historico(id))[0].registrado_por, amb.usuarios.comEditar);
    });

    test('funcionário de outra empresa ou inexistente: o mesmo 404; nada gravado em nenhuma das empresas; o dono consegue', async () => {
      const deB = await amb.trabalhador({ empresaId: amb.d.empresaB });
      const antes = await amb.ler(deB);
      const corpo = { situacao: 'INATIVO', dataEfetiva: '2026-10-01' };
      const cruzado = await mudar(master(), deB, corpo);
      const inexistente = await mudar(master(), 99999999, corpo);
      assert.deepEqual([cruzado.status, cruzado.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
      assert.deepEqual([inexistente.status, inexistente.body], [cruzado.status, cruzado.body]);
      assert.deepEqual(await amb.ler(deB), antes);
      assert.deepEqual(await amb.historico(deB), []);
      const dele = await mudar(amb.usuarios.masterB, deB, corpo);
      assert.equal(dele.status, 200, JSON.stringify(dele.body));
      assert.equal((await amb.historico(deB))[0].empresa_id, amb.d.empresaB);
    });

    test('a empresa nunca vem do cliente: empresaId no corpo é recusado e a linha nasce na empresa da sessão', async () => {
      const id = await amb.trabalhador();
      const r = await mudar(master(), id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01', empresaId: amb.d.empresaB });
      assert.equal(r.status, 400);
      assert.deepEqual(await amb.historico(id), []);
    });
  });

  describe('leitura: eventos de situação e ausência de vazamento', () => {
    const lerEventos = (usuario, id) => amb.como(usuario).get(`/api/funcionarios/${id}/eventos?tipo=SITUACAO`);
    const CHAVES_ANTIGAS = ['anterior', 'id', 'novo', 'ocorridoEm', 'responsavel', 'tipo'];

    test('eventos novos com data trazem dataEfetiva; a reativação de inativo (sem data) mantém exatamente as chaves antigas', async () => {
      const id = await amb.trabalhador();
      await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: '2026-09-01' });
      await mudar(master(), id, { situacao: 'ATIVO' });
      const r = await lerEventos(master(), id);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [reativacao, desligamento] = r.body.eventos;
      assert.deepEqual([desligamento.anterior, desligamento.novo, desligamento.dataEfetiva], ['ATIVO', 'INATIVO', '2026-09-01']);
      assert.deepEqual(Object.keys(desligamento).sort(), [...CHAVES_ANTIGAS, 'dataEfetiva'].sort());
      assert.deepEqual([reativacao.anterior, reativacao.novo], ['INATIVO', 'ATIVO']);
      assert.deepEqual(Object.keys(reativacao).sort(), CHAVES_ANTIGAS, 'sem data não há chave dataEfetiva (nem null)');
    });

    test('evento legado (auditoria sem linha de histórico) continua com as chaves antigas e sem dataEfetiva', async () => {
      const id = await amb.trabalhador();
      await amb.pool.query(
        `INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, dados_anteriores, dados_novos, criado_em)
         VALUES ($1, $2, 'FUNCIONARIO_SITUACAO_ALTERADA', $3, '{"situacao":"ATIVO"}', '{"situacao":"AFASTADO"}', '2026-02-01T12:00:00Z')`,
        [amb.d.empresaA, master(), String(id)],
      );
      const r = await lerEventos(master(), id);
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.deepEqual(Object.keys(r.body.eventos[0]).sort(), CHAVES_ANTIGAS);
    });

    test('leitura continua exigindo employeeHistory.visualizar; quem só visualiza lê; sem permissão 403', async () => {
      const id = await amb.trabalhador();
      await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: '2026-09-01' });
      assert.equal((await lerEventos(amb.usuarios.soVisualizar, id)).status, 200);
      assert.equal((await lerEventos(amb.usuarios.semPermissao, id)).status, 403);
    });

    test('o evento de outra empresa não aparece e o 404 é o mesmo do inexistente', async () => {
      const deB = await amb.trabalhador({ empresaId: amb.d.empresaB });
      await mudar(amb.usuarios.masterB, deB, { situacao: 'INATIVO', dataEfetiva: '2026-09-01' });
      const cruzado = await lerEventos(master(), deB);
      const inexistente = await lerEventos(master(), 99999999);
      assert.deepEqual([cruzado.status, cruzado.body], [inexistente.status, inexistente.body]);
    });

    test('GET /funcionarios/:id e a listagem não trazem dataEfetiva nem ultimaMudancaSituacao', async () => {
      const id = await amb.trabalhador();
      await mudar(master(), id, { situacao: 'INATIVO', dataEfetiva: '2026-09-01' });
      const um = await amb.como(master()).get(`/api/funcionarios/${id}`);
      const lista = await amb.como(master()).get('/api/funcionarios?limite=100');
      assert.equal(um.status, 200);
      assert.equal(lista.status, 200);
      for (const corpo of [um.body, lista.body]) assert.doesNotMatch(JSON.stringify(corpo), /dataEfetiva|ultimaMudancaSituacao|2026-09-01/);
    });
  });

  describe('histórico imutável e compatibilidade', () => {
    test('a rota de dados (PATCH) continua sem alterar situação e não cria linha de histórico', async () => {
      const id = await amb.trabalhador();
      const antes = await amb.ler(id);
      for (const corpo of [{ situacao: 'AFASTADO' }, { ativo: false }, { dataEfetiva: '2026-10-01' }]) {
        assert.equal((await amb.como(master()).patch(`/api/funcionarios/${id}`, corpo)).status, 400, JSON.stringify(corpo));
      }
      assert.deepEqual(await amb.ler(id), antes);
      assert.deepEqual(await amb.historico(id), []);
    });

    test('editar dados cadastrais de quem tem histórico não altera nem cria linhas de situação', async () => {
      const id = await amb.trabalhador();
      await mudar(master(), id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' });
      const antes = JSON.stringify(await amb.historico(id));
      const r = await amb.como(master()).patch(`/api/funcionarios/${id}`, { setor: 'Outro setor' });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(JSON.stringify(await amb.historico(id)), antes);
    });
  });
});
