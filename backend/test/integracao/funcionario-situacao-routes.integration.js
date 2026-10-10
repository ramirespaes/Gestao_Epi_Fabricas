'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteSituacao, DISPOSITIVO } = require('./helpers/ambiente-funcionario-situacao');

/**
 * S2 (RED) — situação funcional do funcionário: `POST /api/funcionarios/:id/situacao`.
 *
 * Contrato esperado (aprovado em 09/10/2026):
 *   - situações ATIVO, AFASTADO e INATIVO; transições: ATIVO→AFASTADO|INATIVO, AFASTADO→ATIVO|INATIVO, INATIVO→ATIVO;
 *   - INATIVO→AFASTADO e a mesma situação são recusadas (409 FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA e
 *     FUNCIONARIO_SITUACAO_IGUAL); valor fora dos três estados é 400 VALIDACAO;
 *   - permissão `employeeHistory.editar`; o PATCH genérico nunca altera a situação;
 *   - toda mudança válida grava `FUNCIONARIO_SITUACAO_ALTERADA` na mesma transação (ator, empresa, anterior, nova,
 *     ip, dispositivo, origem GESTAO_FUNCIONARIOS), sem CPF, telefone nem nascimento;
 *   - os eventos legados FUNCIONARIO_INATIVADO / FUNCIONARIO_REATIVADO só acompanham ATIVO→INATIVO e INATIVO→ATIVO;
 *     transições com AFASTADO não os geram;
 *   - as rotas legadas inativar/reativar continuam: convergem para INATIVO e ATIVO (a partir de AFASTADO também).
 *
 * A rota ainda não existe: toda falha deste arquivo é de comportamento ausente (status, código, estado, auditoria),
 * nunca de harness. A concorrência está em funcionario-situacao-concorrencia.integration.js.
 */

const ROTA = (id) => `/api/funcionarios/${id}/situacao`;
const SITUACOES = ['ATIVO', 'AFASTADO', 'INATIVO'];

describe('S2 — situação do funcionário (rota, regras, auditoria e rotas legadas)', () => {
  let amb;
  before(async () => { amb = await montarAmbienteSituacao(); });
  after(async () => { if (amb) await amb.encerrar(); });

  const mudar = (usuarioId, id, situacao) => amb.como(usuarioId).post(ROTA(id), { situacao });
  const master = () => amb.usuarios.master;

  describe('transições permitidas', () => {
    const PERMITIDAS = [
      ['ATIVO', 'AFASTADO'],
      ['ATIVO', 'INATIVO'],
      ['AFASTADO', 'ATIVO'],
      ['AFASTADO', 'INATIVO'],
      ['INATIVO', 'ATIVO'],
    ];
    for (const [de, para] of PERMITIDAS) {
      test(`${de} → ${para}: 200, a resposta e o banco trazem a nova situação e \`ativo\` acompanha`, async () => {
        const id = await amb.trabalhador(de);
        const r = await mudar(master(), id, para);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.equal(r.body.funcionario?.situacao, para);
        assert.equal(r.body.funcionario?.ativo, para === 'ATIVO');
        assert.equal(r.body.situacaoAnterior, de);
        const gravado = await amb.ler(id);
        assert.equal(gravado.situacao, para);
        assert.equal(gravado.ativo, para === 'ATIVO');
      });
    }

    test('a resposta nunca traz o CPF completo (só o mascarado, como as demais rotas)', async () => {
      const id = await amb.trabalhador('ATIVO');
      const r = await mudar(master(), id, 'AFASTADO');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.funcionario?.cpf, undefined);
      assert.match(r.body.funcionario?.cpfMascarado ?? '', /^\*\*\*\.\*\*\*\.\*\*\*-\d{2}$/);
    });

    test('a consulta do funcionário passa a expor a situação', async () => {
      const id = await amb.trabalhador('AFASTADO');
      const r = await amb.como(master()).get(`/api/funcionarios/${id}`);
      assert.equal(r.status, 200);
      assert.equal(r.body.funcionario.situacao, 'AFASTADO');
      assert.equal(r.body.funcionario.ativo, false);
    });
  });

  describe('transições recusadas', () => {
    test('INATIVO → AFASTADO: 409 FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA; nada muda e nada é auditado', async () => {
      const id = await amb.trabalhador('INATIVO');
      const antes = await amb.ler(id);
      const r = await mudar(master(), id, 'AFASTADO');
      assert.deepEqual([r.status, r.body.codigo], [409, 'FUNCIONARIO_SITUACAO_TRANSICAO_INVALIDA']);
      assert.deepEqual(await amb.ler(id), antes);
      assert.deepEqual(await amb.eventos(id), []);
    });

    for (const situacao of SITUACOES) {
      test(`a mesma situação (${situacao} → ${situacao}): 409 FUNCIONARIO_SITUACAO_IGUAL; nada muda e nada é auditado`, async () => {
        const id = await amb.trabalhador(situacao);
        const antes = await amb.ler(id);
        const r = await mudar(master(), id, situacao);
        assert.deepEqual([r.status, r.body.codigo], [409, 'FUNCIONARIO_SITUACAO_IGUAL']);
        assert.deepEqual(await amb.ler(id), antes);
        assert.deepEqual(await amb.eventos(id), []);
      });
    }

    test('valor inválido ou corpo fora do contrato: 400 VALIDACAO, sem gravar', async () => {
      const id = await amb.trabalhador('ATIVO');
      const antes = await amb.ler(id);
      const corpos = [
        { situacao: 'DESLIGADO' },
        { situacao: 'ativo' },
        { situacao: 'Afastado' },
        { situacao: '' },
        { situacao: null },
        { situacao: 1 },
        { situacao: ['AFASTADO'] },
        {},
        { situacao: 'AFASTADO', ativo: false },
        { situacao: 'AFASTADO', empresaId: 999 },
        { situacao: 'AFASTADO', motivo: 'x' },
      ];
      for (const corpo of corpos) {
        const r = await amb.como(master()).post(ROTA(id), corpo);
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], JSON.stringify(corpo));
      }
      assert.deepEqual(await amb.ler(id), antes);
      assert.deepEqual(await amb.eventos(id), []);
    });

    test('identificador inválido na URL: 400 VALIDACAO', async () => {
      for (const id of ['0', '-1', 'abc', '1.5']) {
        const r = await amb.como(master()).post(ROTA(id), { situacao: 'AFASTADO' });
        assert.deepEqual([r.status, r.body.codigo], [400, 'VALIDACAO'], id);
      }
    });

    test('o PATCH genérico nunca altera a situação (nem `ativo`): 400 e o banco não muda', async () => {
      const id = await amb.trabalhador('ATIVO');
      const antes = await amb.ler(id);
      for (const corpo of [{ situacao: 'AFASTADO' }, { ativo: false }, { situacao: 'INATIVO', setor: 'Qualquer' }]) {
        const r = await amb.como(master()).patch(`/api/funcionarios/${id}`, corpo);
        assert.equal(r.status, 400, JSON.stringify(corpo));
      }
      assert.deepEqual(await amb.ler(id), antes);
    });
  });

  describe('permissão e isolamento', () => {
    test('sem sessão: 401; sem permissão ou só `visualizar`: 403; nada é gravado', async () => {
      const id = await amb.trabalhador('ATIVO');
      const antes = await amb.ler(id);
      const anonimo = await amb.anonimo.post(ROTA(id), { situacao: 'AFASTADO' });
      assert.equal(anonimo.status, 401);
      assert.equal((await mudar(amb.usuarios.semPermissao, id, 'AFASTADO')).status, 403);
      assert.equal((await mudar(amb.usuarios.soVisualizar, id, 'AFASTADO')).status, 403);
      assert.deepEqual(await amb.ler(id), antes);
      assert.deepEqual(await amb.eventos(id), []);
    });

    test('com `employeeHistory.editar` (usuário comum) a mudança é aceita; o MASTER provisionado também', async () => {
      const a = await amb.trabalhador('ATIVO');
      const ra = await mudar(amb.usuarios.comEditar, a, 'AFASTADO');
      assert.equal(ra.status, 200, JSON.stringify(ra.body));
      assert.equal((await amb.ler(a)).situacao, 'AFASTADO');
      const b = await amb.trabalhador('ATIVO');
      const rb = await mudar(amb.usuarios.master, b, 'INATIVO');
      assert.equal(rb.status, 200, JSON.stringify(rb.body));
    });

    test('funcionário inexistente: 404 FUNCIONARIO_NAO_ENCONTRADO', async () => {
      const r = await mudar(master(), 999999, 'AFASTADO');
      assert.deepEqual([r.status, r.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
    });

    test('funcionário de outra empresa: o mesmo 404, e o dele não muda (nem auditoria)', async () => {
      const antes = await amb.ler(amb.d.trabalhadorB);
      const r = await mudar(master(), amb.d.trabalhadorB, 'AFASTADO');
      assert.deepEqual([r.status, r.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
      assert.deepEqual(await amb.ler(amb.d.trabalhadorB), antes);
      assert.deepEqual(await amb.eventos(amb.d.trabalhadorB), []);
      const dele = await mudar(amb.usuarios.masterB, amb.d.trabalhadorB, 'AFASTADO');
      assert.equal(dele.status, 200, JSON.stringify(dele.body));
    });
  });

  describe('auditoria FUNCIONARIO_SITUACAO_ALTERADA', () => {
    test('uma linha por mudança, com funcionário, anterior, nova, ator, empresa, instante, ip, dispositivo e origem', async () => {
      const id = await amb.trabalhador('ATIVO');
      const r = await mudar(master(), id, 'AFASTADO');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const linhas = await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', id);
      assert.equal(linhas.length, 1);
      const [linha] = linhas;
      assert.equal(linha.referencia, String(id));
      assert.equal(linha.empresa_id, amb.d.empresaA);
      assert.equal(linha.usuario_id, master());
      assert.ok(typeof linha.ip === 'string' && linha.ip.length > 0, 'ip ausente');
      assert.equal(linha.dispositivo, DISPOSITIVO);
      assert.equal(linha.contexto?.origem, 'GESTAO_FUNCIONARIOS');
      assert.equal(linha.dados_anteriores?.situacao, 'ATIVO');
      assert.equal(linha.dados_novos?.situacao, 'AFASTADO');
      assert.ok(Math.abs(linha.agora - linha.criado_em) < 60_000, 'data/hora fora da transação da alteração');
    });

    test('anterior e nova corretas em cada transição permitida', async () => {
      for (const [de, para] of [['ATIVO', 'INATIVO'], ['AFASTADO', 'ATIVO'], ['AFASTADO', 'INATIVO'], ['INATIVO', 'ATIVO']]) {
        const id = await amb.trabalhador(de);
        const r = await mudar(master(), id, para);
        assert.equal(r.status, 200, `${de} → ${para}: ${JSON.stringify(r.body)}`);
        const [linha] = await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', id);
        assert.equal(linha?.dados_anteriores?.situacao, de);
        assert.equal(linha?.dados_novos?.situacao, para);
      }
    });

    test('nunca CPF, telefone nem data de nascimento, nem as chaves correspondentes', async () => {
      const id = await amb.trabalhador('ATIVO');
      await amb.pool.query("UPDATE funcionarios SET telefone = '47988776655', data_nascimento = '1987-06-15' WHERE id = $1", [id]);
      const { cpf } = await amb.ler(id);
      const r = await mudar(master(), id, 'AFASTADO');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      const [linha] = await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', id);
      assert.ok(linha, 'sem linha de auditoria');
      const texto = JSON.stringify([linha.contexto, linha.dados_anteriores, linha.dados_novos, linha.referencia, linha.dispositivo]);
      for (const proibido of [cpf, '47988776655', '1987-06-15', '15/06/1987']) assert.equal(texto.includes(proibido), false, `vazou ${proibido}`);
      assert.doesNotMatch(texto, /cpf|telefone|nascimento/i);
    });

    test('mesma transação: se a gravação da auditoria falha, a situação não muda (500, estado intacto)', async () => {
      const id = await amb.trabalhador('ATIVO');
      await amb.pool.query(`CREATE FUNCTION s2_falha_auditoria() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN IF NEW.acao = 'FUNCIONARIO_SITUACAO_ALTERADA' THEN RAISE EXCEPTION 'falha induzida pelo teste'; END IF; RETURN NEW; END $$`);
      await amb.pool.query('CREATE TRIGGER trg_s2_falha_auditoria BEFORE INSERT ON logs_auditoria FOR EACH ROW EXECUTE FUNCTION s2_falha_auditoria()');
      try {
        const r = await mudar(master(), id, 'AFASTADO');
        assert.equal(r.status, 500, 'a falha da auditoria deveria derrubar a operação');
        assert.equal((await amb.ler(id)).situacao, 'ATIVO');
      } finally {
        await amb.pool.query('DROP TRIGGER IF EXISTS trg_s2_falha_auditoria ON logs_auditoria');
        await amb.pool.query('DROP FUNCTION IF EXISTS s2_falha_auditoria()');
      }
    });
  });

  describe('eventos legados só nas transições ATIVO↔INATIVO', () => {
    const MATRIZ = [
      ['ATIVO', 'INATIVO', ['FUNCIONARIO_INATIVADO', 'FUNCIONARIO_SITUACAO_ALTERADA']],
      ['INATIVO', 'ATIVO', ['FUNCIONARIO_REATIVADO', 'FUNCIONARIO_SITUACAO_ALTERADA']],
      ['ATIVO', 'AFASTADO', ['FUNCIONARIO_SITUACAO_ALTERADA']],
      ['AFASTADO', 'ATIVO', ['FUNCIONARIO_SITUACAO_ALTERADA']],
      ['AFASTADO', 'INATIVO', ['FUNCIONARIO_SITUACAO_ALTERADA']],
    ];
    for (const [de, para, esperados] of MATRIZ) {
      test(`${de} → ${para} pela rota nova: ${esperados.join(' + ')}`, async () => {
        const id = await amb.trabalhador(de);
        const r = await mudar(master(), id, para);
        assert.equal(r.status, 200, JSON.stringify(r.body));
        assert.deepEqual((await amb.eventos(id)).sort(), [...esperados].sort());
      });
    }
  });

  describe('rotas legadas inativar e reativar continuam existindo e convergem para INATIVO e ATIVO', () => {
    const legado = (id, rota) => amb.como(master()).post(`/api/funcionarios/${id}/${rota}`, {});

    test('inativar ATIVO: 200, alterado, INATIVO; eventos INATIVADO e SITUACAO_ALTERADA', async () => {
      const id = await amb.trabalhador('ATIVO');
      const r = await legado(id, 'inativar');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.alterado, true);
      assert.equal(r.body.funcionario?.situacao, 'INATIVO');
      assert.equal(r.body.funcionario?.ativo, false);
      assert.deepEqual((await amb.eventos(id)).sort(), ['FUNCIONARIO_INATIVADO', 'FUNCIONARIO_SITUACAO_ALTERADA']);
    });

    test('inativar AFASTADO: vai a INATIVO (alterado), só SITUACAO_ALTERADA, sem evento legado', async () => {
      const id = await amb.trabalhador('AFASTADO');
      const r = await legado(id, 'inativar');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.alterado, true);
      assert.equal(r.body.funcionario?.situacao, 'INATIVO');
      assert.deepEqual(await amb.eventos(id), ['FUNCIONARIO_SITUACAO_ALTERADA']);
      const [linha] = await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', id);
      assert.equal(linha?.dados_anteriores?.situacao, 'AFASTADO');
      assert.equal(linha?.dados_novos?.situacao, 'INATIVO');
    });

    test('inativar INATIVO continua idempotente: 200, alterado false, nada auditado', async () => {
      const id = await amb.trabalhador('INATIVO');
      const r = await legado(id, 'inativar');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.alterado, false);
      assert.equal(r.body.funcionario?.situacao, 'INATIVO');
      assert.deepEqual(await amb.eventos(id), []);
    });

    test('reativar INATIVO: 200, alterado, ATIVO; eventos REATIVADO e SITUACAO_ALTERADA', async () => {
      const id = await amb.trabalhador('INATIVO');
      const r = await legado(id, 'reativar');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.alterado, true);
      assert.equal(r.body.funcionario?.situacao, 'ATIVO');
      assert.deepEqual((await amb.eventos(id)).sort(), ['FUNCIONARIO_REATIVADO', 'FUNCIONARIO_SITUACAO_ALTERADA']);
    });

    test('reativar AFASTADO: vai a ATIVO (alterado), só SITUACAO_ALTERADA, sem evento legado', async () => {
      const id = await amb.trabalhador('AFASTADO');
      const r = await legado(id, 'reativar');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.alterado, true);
      assert.equal(r.body.funcionario?.situacao, 'ATIVO');
      assert.deepEqual(await amb.eventos(id), ['FUNCIONARIO_SITUACAO_ALTERADA']);
    });

    test('reativar ATIVO continua idempotente: 200, alterado false, nada auditado', async () => {
      const id = await amb.trabalhador('ATIVO');
      const r = await legado(id, 'reativar');
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.alterado, false);
      assert.equal(r.body.funcionario?.situacao, 'ATIVO');
      assert.deepEqual(await amb.eventos(id), []);
    });
  });
});
