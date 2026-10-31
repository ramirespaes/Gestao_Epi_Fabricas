'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');

const { montarAmbienteSituacaoDatas } = require('./helpers/ambiente-funcionario-situacao-datas');

/**
 * Supressão da auditoria FUNCIONARIO_SITUACAO_RECUSADA por EVENTO (PostgreSQL real, schema temporário).
 *
 * Evento = empresa + ator + colaborador + operação + código técnico da recusa. Dentro de 60 s, a recusa IDÊNTICA é consolidada em
 * uma linha; recusas com código (ou operação, ator, colaborador ou empresa) diferentes são eventos distintos. A linha é gravada fora
 * da transação rejeitada e a gravação é serializada por trava: recusas simultâneas e idênticas geram uma linha só. A recusa nunca
 * muda a situação, o histórico nem o 409, e a auditoria não leva datas nem conteúdo.
 */

const ROTA = (id) => `/api/funcionarios/${id}/situacao`;
const RECUSADA = 'FUNCIONARIO_SITUACAO_RECUSADA';
const DESLIGAR = { situacao: 'INATIVO', dataEfetiva: '2026-10-01' };
const AFASTAR = { situacao: 'AFASTADO', dataEfetiva: '2026-10-01' };

describe('auditoria da recusa de situação — supressão por evento (HTTP + PostgreSQL)', () => {
  let amb;
  before(async () => { amb = await montarAmbienteSituacaoDatas(); });
  after(async () => { if (amb) await amb.encerrar(); });

  const master = () => amb.usuarios.master;
  const mudar = (id, corpo, usuario = master()) => amb.como(usuario).post(ROTA(id), corpo);
  /** Colaborador com entrega em 05/10/2026: desligar ou afastar em 01/10 é recusado por entrega posterior. */
  const comEntrega = async (opcoes) => { const id = await amb.trabalhador(opcoes); await amb.entregar(id, '2026-10-05'); return id; };
  const codigos = async (id) => (await amb.auditoria(RECUSADA, id)).map((l) => `${l.contexto.operacao}:${l.contexto.codigo}`).sort();
  const intacto = async (id) => {
    assert.equal((await amb.ler(id)).situacao, 'ATIVO', 'a situação não muda');
    assert.deepEqual(await amb.historico(id), [], 'nenhuma linha de histórico');
  };

  test('1. a MESMA recusa repetida em menos de 60 s gera uma única linha; todas as respostas seguem 409 e nada muda', async () => {
    const id = await comEntrega();
    for (let i = 0; i < 3; i += 1) {
      const r = await mudar(id, DESLIGAR);
      assert.deepEqual([r.status, r.body.codigo], [409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA'], JSON.stringify(r.body));
    }
    assert.deepEqual(await codigos(id), ['INATIVAR:DESLIGAMENTO_ANTERIOR_A_ENTREGA']);
    await intacto(id);
  });

  test('2. recusas com CÓDIGOS diferentes na mesma janela geram eventos distintos', async () => {
    const id = await comEntrega();
    const a = await mudar(id, DESLIGAR);
    const b = await mudar(id, AFASTAR);
    assert.deepEqual([a.status, a.body.codigo], [409, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA']);
    assert.deepEqual([b.status, b.body.codigo], [409, 'AFASTAMENTO_ANTERIOR_A_ENTREGA']);
    assert.deepEqual(await codigos(id), ['AFASTAR:AFASTAMENTO_ANTERIOR_A_ENTREGA', 'INATIVAR:DESLIGAMENTO_ANTERIOR_A_ENTREGA']);
    await mudar(id, DESLIGAR);
    await mudar(id, AFASTAR);
    assert.equal((await amb.auditoria(RECUSADA, id)).length, 2, 'repetir cada uma continua consolidando');
    await intacto(id);
  });

  test('2b. código de cronologia e código de entrega para o mesmo colaborador são eventos distintos', async () => {
    const id = await comEntrega();
    assert.equal((await mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-05' })).status, 200, 'desligado no dia da entrega');
    assert.equal((await mudar(id, { situacao: 'ATIVO' })).status, 200, 'reativado sem data');
    const cronologia = await mudar(id, { situacao: 'INATIVO', dataEfetiva: '2026-10-04' });
    assert.deepEqual([cronologia.status, cronologia.body.codigo], [409, 'DATA_EFETIVA_ANTERIOR_A_SITUACAO_REGISTRADA']);
    const entrega = await mudar(id, { situacao: 'AFASTADO', dataEfetiva: '2026-10-05' });
    assert.equal(entrega.status, 200, 'no dia da entrega é aceito');
  });

  test('3. o MESMO código depois de 60 s volta a ser registrado; dentro dos 60 s, não', async () => {
    const velha = await comEntrega();
    const recente = await comEntrega();
    const linha = (id, segundos) => amb.pool.query(
      `INSERT INTO logs_auditoria (empresa_id, usuario_id, acao, referencia, contexto, criado_em)
       VALUES ($1, $2, $3, $4, $5, clock_timestamp() - make_interval(secs => $6))`,
      [amb.d.empresaA, master(), RECUSADA, String(id), { operacao: 'INATIVAR', codigo: 'DESLIGAMENTO_ANTERIOR_A_ENTREGA' }, segundos],
    );
    await linha(velha, 61);
    await linha(recente, 30);
    assert.equal((await mudar(velha, DESLIGAR)).status, 409);
    assert.equal((await mudar(recente, DESLIGAR)).status, 409);
    assert.equal((await amb.auditoria(RECUSADA, velha)).length, 2, 'passou da janela: nova linha');
    assert.equal((await amb.auditoria(RECUSADA, recente)).length, 1, 'dentro da janela: consolidada');
  });

  test('4. atores diferentes e colaboradores diferentes são eventos distintos', async () => {
    const x = await comEntrega();
    const y = await comEntrega();
    assert.equal((await mudar(x, DESLIGAR, amb.usuarios.master)).status, 409);
    assert.equal((await mudar(x, DESLIGAR, amb.usuarios.comEditar)).status, 409);
    assert.equal((await mudar(y, DESLIGAR, amb.usuarios.master)).status, 409);
    const doX = await amb.auditoria(RECUSADA, x);
    assert.deepEqual(doX.map((l) => l.usuario_id).sort(), [amb.usuarios.master, amb.usuarios.comEditar].sort());
    assert.equal((await amb.auditoria(RECUSADA, y)).length, 1);
    await intacto(x);
    await intacto(y);
  });

  test('5. empresas distintas nunca se suprimem; cada linha fica na empresa do ator', async () => {
    const a = await comEntrega();
    const b = await comEntrega({ empresaId: amb.d.empresaB });
    assert.equal((await mudar(a, DESLIGAR)).status, 409);
    assert.equal((await mudar(b, DESLIGAR, amb.usuarios.masterB)).status, 409);
    const [la] = await amb.auditoria(RECUSADA, a);
    const [lb] = await amb.auditoria(RECUSADA, b);
    assert.equal(la.empresa_id, amb.d.empresaA);
    assert.equal(lb.empresa_id, amb.d.empresaB);
    const cruzado = await mudar(b, DESLIGAR, master());
    assert.deepEqual([cruzado.status, cruzado.body.codigo], [404, 'FUNCIONARIO_NAO_ENCONTRADO']);
    assert.equal((await amb.auditoria(RECUSADA, b)).length, 1, 'o 404 de outra empresa não audita nem suprime');
  });

  test('6. a linha não leva datas nem conteúdo; a recusa preserva o 409 e a situação, e é gravada fora da transação rejeitada', async () => {
    const id = await comEntrega();
    const r = await mudar(id, DESLIGAR);
    assert.equal(r.status, 409);
    const [linha] = await amb.auditoria(RECUSADA, id);
    assert.deepEqual(linha.contexto, { operacao: 'INATIVAR', codigo: 'DESLIGAMENTO_ANTERIOR_A_ENTREGA' });
    assert.equal(linha.dados_anteriores, null);
    assert.equal(linha.dados_novos, null);
    const conteudo = JSON.stringify([linha.contexto, linha.dados_anteriores, linha.dados_novos, linha.referencia]);
    assert.equal(/\d{4}-\d{2}-\d{2}|dataEfetiva|Luva/.test(conteudo), false, 'nenhuma data nem conteúdo na auditoria');
    assert.deepEqual(await amb.auditoria('FUNCIONARIO_SITUACAO_ALTERADA', id), []);
    await intacto(id);
  });

  test('7. concorrência: recusas idênticas simultâneas geram uma linha só; códigos diferentes simultâneos geram uma de cada', async () => {
    const id = await comEntrega();
    const idênticas = await Promise.all(Array.from({ length: 8 }, () => mudar(id, DESLIGAR)));
    assert.deepEqual([...new Set(idênticas.map((r) => r.status))], [409]);
    assert.deepEqual(await codigos(id), ['INATIVAR:DESLIGAMENTO_ANTERIOR_A_ENTREGA']);
    const outro = await comEntrega();
    const mistas = await Promise.all([...Array.from({ length: 4 }, () => mudar(outro, DESLIGAR)), ...Array.from({ length: 4 }, () => mudar(outro, AFASTAR))]);
    assert.deepEqual([...new Set(mistas.map((r) => r.status))], [409]);
    assert.deepEqual(await codigos(outro), ['AFASTAR:AFASTAMENTO_ANTERIOR_A_ENTREGA', 'INATIVAR:DESLIGAMENTO_ANTERIOR_A_ENTREGA']);
    await intacto(id);
    await intacto(outro);
  });

  test('7b. a trava, isolada da serialização do colaborador: 16 gravações idênticas da auditoria em paralelo geram uma linha; 16 mistas, uma por código', async () => {
    const servico = require('../../src/services/funcionario.service');
    assert.equal(typeof servico.auditarRecusaDeSituacao, 'function');
    const id = await comEntrega();
    const dados = { empresaId: amb.d.empresaA, atorId: master(), funcionarioId: id, ip: '127.0.0.1', dispositivo: 'teste' };
    await Promise.all(Array.from({ length: 16 }, () => servico.auditarRecusaDeSituacao(amb.pool, { ...dados, situacao: 'INATIVO' }, 'DESLIGAMENTO_ANTERIOR_A_ENTREGA')));
    assert.deepEqual(await codigos(id), ['INATIVAR:DESLIGAMENTO_ANTERIOR_A_ENTREGA']);
    const outro = await comEntrega();
    const mistas = [['INATIVO', 'DESLIGAMENTO_ANTERIOR_A_ENTREGA'], ['AFASTADO', 'AFASTAMENTO_ANTERIOR_A_ENTREGA']];
    await Promise.all(Array.from({ length: 16 }, (_, i) => {
      const [situacao, codigo] = mistas[i % 2];
      return servico.auditarRecusaDeSituacao(amb.pool, { ...dados, funcionarioId: outro, situacao }, codigo);
    }));
    assert.deepEqual(await codigos(outro), ['AFASTAR:AFASTAMENTO_ANTERIOR_A_ENTREGA', 'INATIVAR:DESLIGAMENTO_ANTERIOR_A_ENTREGA']);
  });
});
