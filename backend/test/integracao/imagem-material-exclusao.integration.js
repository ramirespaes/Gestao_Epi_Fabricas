'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirAmbienteImagens, descritor, CLASSIFICACAO_OUTROS } = require('./helpers/imagem-material');
const { exigirModulo } = require('../helpers/exigir-modulo');
const materialService = require('../../src/services/material.service');

/**
 * Biblioteca de Imagens, Unidade 3 (RED — contrato de EXCLUSÃO de imagem PRIVADA, V7 seção 2; NÃO implementado nesta rodada; ESTES TESTES FALHAM DE
 * PROPÓSITO e são a especificação do GREEN seguinte). PostgreSQL real, banco de teste exclusivo, schema temporário exclusivo.
 *
 * `excluir(pool, { empresaId, atorId, imagemId, confirmacao: true })` remove a linha da biblioteca da empresa (a imagem some da biblioteca e deixa de
 * contar na cota). Três operações DISTINTAS: INATIVAR (a imagem fica, conta na cota, pode ser reativada), EXCLUIR DA BIBLIOTECA (esta) e SOLTAR a
 * imagem do material (`material.alterar` com `imagem: null`: o material sobrevive e a imagem continua na biblioteca). A exclusão não toca em
 * arquivos: a limpeza física definitiva é outra operação, futura. Imagem padrão nunca é excluída pela API da empresa; operação entre empresas não existe.
 */

const servico = () => exigirModulo('src/services/imagem-material.service');
const NAO_ENCONTRADA = [404, 'IMAGEM_NAO_ENCONTRADA'];
async function esperarErro(promessa, status, codigo) {
  await assert.rejects(promessa, (e) => { assert.equal(e.status, status, `${e.status} ${e.codigo}`); assert.equal(e.codigo, codigo); return true; });
}

describe('Exclusão de imagem privada da empresa — contrato (PostgreSQL real)', () => {
  let a;
  let A;
  let B;
  let ATOR_A;
  let ATOR_B;
  let seq = 0;

  before(async () => {
    a = await abrirAmbienteImagens();
    ({ empresaA: A, empresaB: B, atorA: ATOR_A, atorB: ATOR_B } = a.d);
  });
  after(async () => { if (a) await a.encerrar(); });

  const registrar = async (empresaId = A, atorId = ATOR_A, extra = {}) => (await servico().registrarEmpresa(a.pool, { empresaId, atorId, nome: `Imagem EXC ${++seq}`, imagem: descritor(extra) })).imagem;
  const excluir = async (imagemId, extra = {}) => {
    const s = servico();
    assert.equal(typeof s.excluir, 'function', 'a operação `excluir` ainda não foi implementada');
    return s.excluir(a.pool, { empresaId: A, atorId: ATOR_A, imagemId, confirmacao: true, ...extra });
  };
  const criarMaterial = (imagem) => materialService.criar(a.pool, {
    empresaId: A, atorId: ATOR_A, nome: `Material EXC ${++seq}`, prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS, ...(imagem ? { imagem } : {}),
  });
  const existe = async (id) => (await a.contagem('imagens_empresa', 'id = $1', [id])) === 1;

  test('EXC-01: imagem sem vínculos é excluída — a linha some, deixa de ser listada e a resposta traz { excluida: true, imagemId }', async () => {
    const img = await registrar();
    const r = await excluir(img.id);
    assert.deepEqual(r, { excluida: true, imagemId: img.id });
    assert.equal(await existe(img.id), false);
    const lista = await servico().listar(a.pool, { empresaId: A, origem: 'EMPRESA', estado: 'TODAS', limite: 100 });
    assert.equal(lista.imagens.some((i) => i.id === img.id), false);
  });

  test('EXC-02: a imagem INATIVA sem vínculos também é excluída (não é preciso inativar antes), e a ATIVA sem vínculos idem', async () => {
    const inativa = await registrar();
    await servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: inativa.id });
    assert.equal((await excluir(inativa.id)).excluida, true);
    assert.equal(await existe(inativa.id), false);
  });

  test('EXC-03: sem confirmação explícita (`confirmacao: true`) é 400 VALIDACAO e nada é apagado', async () => {
    const img = await registrar();
    for (const confirmacao of [undefined, false, 'true', 1]) {
      await assert.rejects(excluir(img.id, { confirmacao }), (e) => e.status === 400 && e.codigo === 'VALIDACAO');
    }
    assert.equal(await existe(img.id), true);
  });

  test('EXC-04: imagem vinculada a material (ativo ou inativo) é 409 IMAGEM_EM_USO e NADA muda: linha, vínculo e auditoria', async () => {
    const img = await registrar();
    const m = await criarMaterial({ origem: 'EMPRESA', id: img.id });
    const logs = await a.contagem('logs_auditoria');
    await esperarErro(excluir(img.id), 409, 'IMAGEM_EM_USO');
    assert.equal(await existe(img.id), true);
    assert.equal((await a.imagemDoMaterial(m.id)).imagem_empresa_id, img.id);
    assert.equal(await a.contagem('logs_auditoria'), logs);
    await materialService.inativar(a.pool, { empresaId: A, atorId: ATOR_A, materialId: m.id });
    await esperarErro(excluir(img.id), 409, 'IMAGEM_EM_USO');
  });

  test('EXC-05: o MESMO 404 uniforme para imagem inexistente, de OUTRA empresa e id de imagem PADRÃO; a imagem da outra empresa e a padrão ficam intactas (nenhuma operação entre empresas, nenhuma exclusão da biblioteca padrão)', async () => {
    const deB = await registrar(B, ATOR_B);
    const padrao = await a.padrao({ nome: 'Padrão intocável EXC05' });
    const e1 = await excluir(deB.id).then(() => null, (e) => e);
    const e2 = await excluir('987654321987').then(() => null, (e) => e);
    for (const e of [e1, e2]) assert.deepEqual([e.status, e.codigo], NAO_ENCONTRADA);
    assert.equal(e1.message, e2.message);
    assert.equal(await existe(deB.id), true);
    // A exclusão só enxerga a biblioteca da empresa: não existe caminho de código que apague a biblioteca padrão.
    assert.equal(await a.contagem('imagens_padrao', 'id = $1', [padrao.id]), 1);
    assert.equal(Object.keys(servico()).some((n) => /padrao/i.test(n) && /excluir|remover|apagar/i.test(n)), false);
    assert.equal(typeof servico().excluir, 'function', 'a operação `excluir` ainda não foi implementada');
  });

  test('EXC-06: três operações distintas — inativar mantém a linha (e a cota), soltar do material mantém a imagem, excluir remove só a linha da biblioteca', async () => {
    const img = await registrar();
    const m = await criarMaterial({ origem: 'EMPRESA', id: img.id });
    // soltar da seleção do material: a imagem continua na biblioteca, ATIVA, e o material continua existindo
    await materialService.alterar(a.pool, { empresaId: A, atorId: ATOR_A, materialId: m.id, imagem: null });
    assert.equal(await existe(img.id), true);
    assert.equal((await a.q('SELECT estado FROM imagens_empresa WHERE id = $1', [img.id])).rows[0].estado, 'ATIVA');
    assert.equal(await a.contagem('materiais', 'id = $1', [m.id]), 1);
    // inativar: a linha fica e continua contando na cota
    await servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: img.id });
    const consumo = async () => (await a.q('SELECT count(*)::int AS n FROM imagens_empresa WHERE empresa_id = $1', [A])).rows[0].n;
    const comInativa = await consumo();
    assert.equal(await existe(img.id), true);
    // excluir: só agora a linha some e a cota lógica é liberada
    await excluir(img.id);
    assert.equal(await consumo(), comInativa - 1);
    assert.equal(await a.contagem('materiais', 'id = $1', [m.id]), 1, 'o material nunca é afetado');
  });

  test('EXC-07: a exclusão libera a cota — com a cota cheia, excluir uma imagem abre vaga para registrar outra', async () => {
    const img = await registrar();
    const total = await a.contagem('imagens_empresa', 'empresa_id = $1', [A]);
    const limites = { cotaImagens: total, cotaBytes: 1024 * 1024 * 1024 };
    await esperarErro(servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'Sem vaga', imagem: descritor(), limites }), 409, 'IMAGEM_COTA_EXCEDIDA');
    await excluir(img.id);
    assert.equal((await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'Com vaga', imagem: descritor(), limites })).reaproveitada, false);
  });

  test('EXC-08: depois de excluída, o mesmo conteúdo pode ser registrado de novo como imagem NOVA (outro id, reaproveitada=false)', async () => {
    const d = descritor();
    const primeira = (await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'Original EXC08', imagem: d })).imagem;
    await excluir(primeira.id);
    const nova = await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'Depois EXC08', imagem: d });
    assert.equal(nova.reaproveitada, false);
    assert.notEqual(nova.imagem.id, primeira.id);
  });

  test('EXC-09: auditoria IMAGEM_MATERIAL_EXCLUIDA — uma linha, só id, formato e bytes; nenhuma linha quando a exclusão é recusada', async () => {
    const d = descritor();
    const img = (await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'Nome secreto EXC09', imagem: d })).imagem;
    const m = await criarMaterial({ origem: 'EMPRESA', id: img.id });
    await assert.rejects(excluir(img.id));
    assert.equal((await a.auditoria('IMAGEM_MATERIAL_EXCLUIDA', A)).filter((l) => l.referencia === img.id).length, 0);
    await materialService.alterar(a.pool, { empresaId: A, atorId: ATOR_A, materialId: m.id, imagem: null });
    await excluir(img.id, { atorId: a.d.atorA2, ip: '203.0.113.7' });
    const linhas = (await a.auditoria('IMAGEM_MATERIAL_EXCLUIDA', A)).filter((l) => l.referencia === img.id);
    assert.equal(linhas.length, 1);
    assert.equal(linhas[0].usuario_id, a.d.atorA2);
    assert.deepEqual(linhas[0].contexto, { imagemId: img.id, formato: 'PNG', bytes: 139000 });
    const bruto = JSON.stringify(linhas[0]);
    for (const proibido of ['Nome secreto EXC09', d.sha256, d.sha256Mestre, d.sha256Exibicao, d.sha256Miniatura, 'caminho', 'chave']) assert.equal(bruto.includes(proibido), false, proibido);
  });

  describe('concorrência entre associação e exclusão', () => {
    const esperarBloqueio = (pid) => a.esperarBloqueio(pid);

    test('EXC-10: associação em andamento segura a imagem (FOR SHARE): a exclusão ESPERA e, ao concluir, é recusada com 409 IMAGEM_EM_USO; imagem e vínculo permanecem', async () => {
      const img = await registrar();
      const m = await criarMaterial();
      const imagemEmpresaRepo = exigirModulo('src/repositories/imagem-empresa.repository');
      const materialImagemRepo = exigirModulo('src/repositories/material-imagem.repository');
      const c = await a.pool.connect();
      try {
        await c.query('BEGIN');
        const { rows: [{ pid }] } = await c.query('SELECT pg_backend_pid() AS pid');
        await imagemEmpresaRepo.buscarPorIdParaAssociacao(c, A, img.id);
        const exclusao = excluir(img.id).then(() => null, (e) => e);
        await esperarBloqueio(pid);
        await materialImagemRepo.definir(c, A, m.id, { imagemPadraoId: null, imagemEmpresaId: img.id });
        await c.query('COMMIT');
        const erro = await exclusao;
        assert.deepEqual([erro.status, erro.codigo], [409, 'IMAGEM_EM_USO']);
      } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
      assert.equal(await existe(img.id), true);
      assert.equal((await a.imagemDoMaterial(m.id)).imagem_empresa_id, img.id);
    });

    test('EXC-11: exclusão em andamento segura a imagem (FOR UPDATE): a associação ESPERA e, ao concluir, é recusada (404 uniforme), sem gravar nada no material', async () => {
      const img = await registrar();
      const m = await criarMaterial();
      const imagemEmpresaRepo = exigirModulo('src/repositories/imagem-empresa.repository');
      const c = await a.pool.connect();
      try {
        await c.query('BEGIN');
        const { rows: [{ pid }] } = await c.query('SELECT pg_backend_pid() AS pid');
        await imagemEmpresaRepo.buscarPorIdParaAtualizacao(c, A, img.id);
        const associacao = materialService.alterar(a.pool, { empresaId: A, atorId: ATOR_A, materialId: m.id, nome: 'Não pode ficar EXC11', imagem: { origem: 'EMPRESA', id: img.id } }).then(() => null, (e) => e);
        await esperarBloqueio(pid);
        await imagemEmpresaRepo.excluir(c, A, img.id);
        await c.query('COMMIT');
        const erro = await associacao;
        assert.deepEqual([erro.status, erro.codigo], NAO_ENCONTRADA);
      } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
      assert.equal(await existe(img.id), false);
      assert.deepEqual(await a.imagemDoMaterial(m.id), { imagem_padrao_id: null, imagem_empresa_id: null });
      assert.notEqual((await a.linhaDoMaterial(m.id)).nome, 'Não pode ficar EXC11');
    });

    test('EXC-12: associações e exclusões simultâneas terminam todas (sem deadlock) e o resultado é coerente: nenhum material aponta para imagem inexistente (a FK composta é a última barreira)', async () => {
      const imagens = [await registrar(), await registrar(), await registrar()];
      const materiais = [await criarMaterial(), await criarMaterial(), await criarMaterial()];
      const tarefas = [];
      for (const img of imagens) {
        for (const m of materiais) tarefas.push(materialService.alterar(a.pool, { empresaId: A, atorId: ATOR_A, materialId: m.id, imagem: { origem: 'EMPRESA', id: img.id } }));
        tarefas.push(excluir(img.id));
      }
      const limite = new Promise((_, rejeitar) => { setTimeout(() => rejeitar(new Error('deadlock ou espera indefinida')), 20000); });
      const resultados = await Promise.race([Promise.allSettled(tarefas), limite]);
      for (const r of resultados) if (r.status === 'rejected') assert.ok([404, 409].includes(r.reason.status), `erro inesperado: ${r.reason.status} ${r.reason.codigo}`);
      const orfaos = await a.q(
        `SELECT count(*)::int AS n FROM materiais m WHERE m.imagem_empresa_id = ANY($1::bigint[]) AND NOT EXISTS (SELECT 1 FROM imagens_empresa i WHERE i.empresa_id = m.empresa_id AND i.id = m.imagem_empresa_id)`,
        [imagens.map((i) => i.id)],
      );
      assert.equal(orfaos.rows[0].n, 0);
    });
  });

  test('EXC-13 (controle do banco, passa já): a FK da 090 impede apagar por SQL direto uma imagem referenciada por material (RESTRICT) — a última barreira da regra IMAGEM_EM_USO', async () => {
    const img = await a.daEmpresa(A, ATOR_A);
    const m = await a.material(A, 'Material EXC13');
    await a.q('UPDATE materiais SET imagem_empresa_id = $2 WHERE id = $1', [m, img.id]);
    await assert.rejects(a.q('DELETE FROM imagens_empresa WHERE empresa_id = $1 AND id = $2', [A, img.id]), (e) => e.code === '23503');
    assert.equal(await existe(img.id), true);
  });
});
