'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirAmbienteImagens, descritor, CLASSIFICACAO_OUTROS } = require('./helpers/imagem-material');
const { exigirModulo } = require('../helpers/exigir-modulo');
const materialService = require('../../src/services/material.service');
const materialRepo = require('../../src/repositories/material.repository');

/**
 * Biblioteca de Imagens, Unidade 3 (RED) — ASSOCIAÇÃO da imagem ao MATERIAL, pelo próprio serviço de materiais (`material.service.criar` e
 * `alterar`): a imagem é do MATERIAL (id), nunca de nome, tipo, GHE ou tamanho; a associação só é persistida quando o material é SALVO; imagem de
 * outra empresa, inexistente ou inativa é recusada de forma uniforme; ordem de travas material → imagem (FOR SHARE) sem deadlock com a inativação;
 * as regras existentes do material (classificação, grade, estoque mínimo, auditoria) não mudam.
 *
 * Contrato do campo (o mesmo do doc. 07): `imagem` ausente/undefined = não mexer; `null` = remover; `{ origem: 'PADRAO' | 'EMPRESA', id }` = associar.
 * A resposta de criar, alterar e buscar traz `imagem: null | { origem, id, versao, nome }` (nunca hash, bytes, chave ou caminho).
 *
 * PostgreSQL real em schema temporário do banco de teste exclusivo. Hoje falham pela ausência dos módulos novos e do campo `imagem`.
 */

const imagemEmpresaRepo = () => exigirModulo('src/repositories/imagem-empresa.repository');
const materialImagemRepo = () => exigirModulo('src/repositories/material-imagem.repository');
const biblioteca = () => exigirModulo('src/services/imagem-material.service');

const IMAGEM_NAO_ENCONTRADA = [404, 'IMAGEM_NAO_ENCONTRADA'];

async function esperarErro(promessa, status, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.equal(erro.status, status, `status ${erro.status} ${erro.codigo}`);
    assert.equal(erro.codigo, codigo);
    return true;
  });
}

describe('Associação da imagem ao material — persistência só ao salvar, isolamento, uniformidade dos erros, travas e preservação das regras existentes (PostgreSQL real)', () => {
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

  const criarMaterial = (extra = {}) => {
    seq += 1;
    return materialService.criar(a.pool, {
      empresaId: A, atorId: ATOR_A, nome: `Material ASS ${seq}`, prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS, ...extra,
    });
  };
  const imagemDaEmpresa = async (empresaId = A, atorId = ATOR_A) => (await biblioteca().registrarEmpresa(a.pool, { empresaId, atorId, nome: `Imagem ASS ${++seq}`, imagem: descritor() })).imagem;
  const alterar = (materialId, extra) => materialService.alterar(a.pool, { empresaId: A, atorId: ATOR_A, materialId, ...extra });
  const colunas = async (materialId) => a.imagemDoMaterial(materialId);

  describe('[ASS] criar e alterar com imagem', () => {
    test('ASS-01: criar COM imagem da empresa grava a associação no material e devolve `imagem` sem campos internos; criar SEM imagem deixa tudo nulo (regra atual preservada)', async () => {
      const img = await imagemDaEmpresa();
      const com = await criarMaterial({ imagem: { origem: 'EMPRESA', id: img.id } });
      assert.deepEqual(await colunas(com.id), { imagem_padrao_id: null, imagem_empresa_id: img.id });
      assert.deepEqual([com.imagem.origem, com.imagem.id, com.imagem.versao, com.imagem.nome], ['EMPRESA', img.id, 1, img.nome]);
      for (const proibido of ['sha256', 'bytesMestre', 'chave', 'caminho', 'criadoPor', 'empresaId']) assert.equal(proibido in com.imagem, false);
      const sem = await criarMaterial();
      assert.deepEqual(await colunas(sem.id), { imagem_padrao_id: null, imagem_empresa_id: null });
      assert.equal(sem.imagem, null);
    });

    test('ASS-02: criar com imagem PADRÃO grava imagem_padrao_id (e só ele); a mesma padrão serve a materiais de empresas diferentes', async () => {
      const p = await a.padrao({ nome: 'Padrão ASS02' });
      const m = await criarMaterial({ imagem: { origem: 'PADRAO', id: p.id } });
      assert.deepEqual(await colunas(m.id), { imagem_padrao_id: p.id, imagem_empresa_id: null });
      assert.deepEqual([m.imagem.origem, m.imagem.id, m.imagem.nome], ['PADRAO', p.id, 'Padrão ASS02']);
      const deB = await materialService.criar(a.pool, { empresaId: B, atorId: ATOR_B, nome: 'Material B ASS02', prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS, imagem: { origem: 'PADRAO', id: p.id } });
      assert.equal((await colunas(deB.id)).imagem_padrao_id, p.id);
    });

    test('ASS-03: alterar — `imagem` ausente NÃO mexe na associação (nem na auditoria); `null` remove; trocar de origem zera a outra coluna (no máximo uma imagem)', async () => {
      const img = await imagemDaEmpresa();
      const p = await a.padrao({ nome: 'Padrão ASS03' });
      const m = await criarMaterial({ imagem: { origem: 'EMPRESA', id: img.id } });
      await alterar(m.id, { nome: 'Renomeado ASS03' });
      assert.deepEqual(await colunas(m.id), { imagem_padrao_id: null, imagem_empresa_id: img.id }, 'ausente = não mexer');
      const log = (await a.auditoria('MATERIAL_ALTERADO', A)).filter((l) => l.referencia === String(m.id)).at(-1);
      assert.equal('imagem' in log.dados_anteriores || 'imagem' in log.dados_novos, false, 'a auditoria só fala da imagem quando ela foi informada');
      await alterar(m.id, { imagem: { origem: 'PADRAO', id: p.id } });
      assert.deepEqual(await colunas(m.id), { imagem_padrao_id: p.id, imagem_empresa_id: null });
      await alterar(m.id, { imagem: { origem: 'EMPRESA', id: img.id } });
      assert.deepEqual(await colunas(m.id), { imagem_padrao_id: null, imagem_empresa_id: img.id });
      const removido = await alterar(m.id, { imagem: null });
      assert.deepEqual(await colunas(m.id), { imagem_padrao_id: null, imagem_empresa_id: null });
      assert.equal(removido.imagem, null);
    });

    test('ASS-04: um corpo só com `imagem` é uma alteração válida (não é MATERIAL_SEM_ALTERACAO) e não altera nenhum outro dado do material', async () => {
      const img = await imagemDaEmpresa();
      const m = await criarMaterial({ estoqueMinimo: 7, fabricante: 'Fabricante ASS04', descricao: 'Descrição ASS04' });
      const antes = await a.linhaDoMaterial(m.id);
      await alterar(m.id, { imagem: { origem: 'EMPRESA', id: img.id } });
      const depois = await a.linhaDoMaterial(m.id);
      const sem = (j) => { const c = { ...j }; delete c.imagem_empresa_id; delete c.imagem_padrao_id; delete c.atualizado_em; return c; };
      assert.deepEqual(sem(depois), sem(antes), 'classificação, grade, estoque mínimo, CA, prazo e demais campos intactos');
      await esperarErro(alterar(m.id, {}), 400, 'MATERIAL_SEM_ALTERACAO');
    });

    test('ASS-05: repetir a mesma imagem é no-op para a associação; a auditoria só registra imagem quando informada, com {origem,id} e nunca hash, bytes ou caminho', async () => {
      const img = await imagemDaEmpresa();
      const m = await criarMaterial({ imagem: { origem: 'EMPRESA', id: img.id } });
      const criado = (await a.auditoria('MATERIAL_CRIADO', A)).find((l) => l.referencia === String(m.id));
      assert.deepEqual(criado.dados_novos.imagem, { origem: 'EMPRESA', id: img.id });
      await alterar(m.id, { imagem: { origem: 'EMPRESA', id: img.id } });
      await alterar(m.id, { imagem: null });
      const log = (await a.auditoria('MATERIAL_ALTERADO', A)).filter((l) => l.referencia === String(m.id)).at(-1);
      assert.deepEqual([log.dados_anteriores.imagem, log.dados_novos.imagem], [{ origem: 'EMPRESA', id: img.id }, null]);
      const bruto = JSON.stringify([criado, log]);
      for (const proibido of ['sha256', 'bytes', 'caminho', 'chave', 'miniatura']) assert.equal(bruto.toLowerCase().includes(proibido), false, `auditoria vazou ${proibido}`);
    });
  });

  describe('[PER] a associação só é persistida quando o material é SALVO', () => {
    test('PER-01: escolher e listar imagens (o pop-up) não toca em nenhum material: só o salvamento do material grava', async () => {
      const img = await imagemDaEmpresa();
      const m = await criarMaterial();
      const antes = await a.linhaDoMaterial(m.id);
      await biblioteca().listar(a.pool, { empresaId: A, origem: 'TODAS', busca: String(img.nome) });
      await biblioteca().listar(a.pool, { empresaId: A, origem: 'TODAS' });
      assert.deepEqual(await a.linhaDoMaterial(m.id), antes);
    });

    test('PER-02: criar que FALHA (nome inválido, grade incompatível, classificação inválida) com imagem válida não deixa material, associação nem auditoria', async () => {
      const img = await imagemDaEmpresa();
      const materiais = await a.contagem('materiais', 'empresa_id = $1', [A]);
      const logs = await a.contagem('logs_auditoria');
      await assert.rejects(criarMaterial({ nome: '   ', imagem: { origem: 'EMPRESA', id: img.id } }), (e) => e.status === 400);
      await assert.rejects(criarMaterial({ tamanhos: ['P'], imagem: { origem: 'EMPRESA', id: img.id } }), (e) => e.status === 400);
      await assert.rejects(criarMaterial({ categoria: 'EPI', imagem: { origem: 'EMPRESA', id: img.id } }), (e) => e.status === 400);
      assert.deepEqual([await a.contagem('materiais', 'empresa_id = $1', [A]), await a.contagem('logs_auditoria')], [materiais, logs]);
      assert.equal(await a.contagem('materiais', 'imagem_empresa_id = $1', [img.id]), 0);
    });

    test('PER-03: alterar que FALHA por outro campo (prazo inválido) não troca a imagem; e imagem inválida desfaz TAMBÉM as outras alterações da mesma requisição (tudo ou nada)', async () => {
      const antiga = await imagemDaEmpresa();
      const nova = await imagemDaEmpresa();
      const m = await criarMaterial({ imagem: { origem: 'EMPRESA', id: antiga.id } });
      const logs = await a.contagem('logs_auditoria');
      await assert.rejects(alterar(m.id, { prazoUsoDias: -1, prazoUsoDiasInformado: true, imagem: { origem: 'EMPRESA', id: nova.id } }), (e) => e.status === 400);
      assert.equal((await colunas(m.id)).imagem_empresa_id, antiga.id);
      await esperarErro(alterar(m.id, { nome: 'Nome que não pode ficar', imagem: { origem: 'EMPRESA', id: 999999991 } }), ...IMAGEM_NAO_ENCONTRADA);
      assert.notEqual((await a.linhaDoMaterial(m.id)).nome, 'Nome que não pode ficar');
      assert.equal((await colunas(m.id)).imagem_empresa_id, antiga.id);
      assert.equal(await a.contagem('logs_auditoria'), logs, 'nenhuma auditoria nas recusas');
    });
  });

  describe('[ISO] imagem de outra empresa, inexistente ou inativa: erro uniforme e nada gravado', () => {
    test('ISO-01: criar e alterar com imagem de OUTRA empresa, inexistente, inativa (empresa) ou padrão inativa/inexistente dão o MESMO 404 IMAGEM_NAO_ENCONTRADA (status, código e mensagem idênticos)', async () => {
      const deB = await imagemDaEmpresa(B, ATOR_B);
      const inativa = await imagemDaEmpresa();
      await biblioteca().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: inativa.id });
      const padraoInativa = await a.padrao({ nome: 'Padrão inativa ISO01', ativo: false });
      const m = await criarMaterial();
      const materiais = await a.contagem('materiais', 'empresa_id = $1', [A]);
      const alvos = [
        { origem: 'EMPRESA', id: deB.id }, { origem: 'EMPRESA', id: 987654321 }, { origem: 'EMPRESA', id: inativa.id },
        { origem: 'PADRAO', id: padraoInativa.id }, { origem: 'PADRAO', id: 987654321 },
      ];
      const mensagens = new Set();
      for (const imagem of alvos) {
        const e1 = await criarMaterial({ imagem }).then(() => null, (e) => e);
        const e2 = await alterar(m.id, { imagem }).then(() => null, (e) => e);
        for (const e of [e1, e2]) { assert.deepEqual([e.status, e.codigo], IMAGEM_NAO_ENCONTRADA, JSON.stringify(imagem)); mensagens.add(e.message); }
      }
      assert.equal(mensagens.size, 1, 'a mensagem é uma só: não revela se o id existe, de quem é ou se está inativo');
      assert.equal(await a.contagem('materiais', 'empresa_id = $1', [A]), materiais, 'nenhum material criado nas recusas');
      assert.deepEqual(await colunas(m.id), { imagem_padrao_id: null, imagem_empresa_id: null });
    });

    test('ISO-02: alterar material de OUTRA empresa com imagem válida é 404 MATERIAL_NAO_ENCONTRADO (o material é checado antes da imagem) e nada muda', async () => {
      const img = await imagemDaEmpresa();
      const deB = await materialService.criar(a.pool, { empresaId: B, atorId: ATOR_B, nome: 'Material B ISO02', prazoUsoDias: 180, exigeTamanho: false, unidade: 'unidade', ...CLASSIFICACAO_OUTROS });
      await esperarErro(alterar(deB.id, { imagem: { origem: 'EMPRESA', id: img.id } }), 404, 'MATERIAL_NAO_ENCONTRADO');
      assert.deepEqual(await colunas(deB.id), { imagem_padrao_id: null, imagem_empresa_id: null });
    });

    test('ISO-03: material que JÁ tem a imagem a mantém depois de ela ficar inativa por fora do serviço (padrão desativada pelo operador); reenviar a mesma é aceito, trocar para outra inativa é 404', async () => {
      const p = await a.padrao({ nome: 'Padrão ISO03' });
      const m = await criarMaterial({ imagem: { origem: 'PADRAO', id: p.id } });
      await a.q('UPDATE imagens_padrao SET ativo = false WHERE id = $1', [p.id]);
      await alterar(m.id, { nome: 'Outro nome ISO03' });
      assert.equal((await colunas(m.id)).imagem_padrao_id, p.id, 'a associação existente sobrevive à inativação');
      await alterar(m.id, { imagem: { origem: 'PADRAO', id: p.id } });
      const outra = await a.padrao({ nome: 'Outra padrão ISO03', ativo: false });
      await esperarErro(alterar(m.id, { imagem: { origem: 'PADRAO', id: outra.id } }), ...IMAGEM_NAO_ENCONTRADA);
      assert.equal((await colunas(m.id)).imagem_padrao_id, p.id);
    });

    test('ISO-04: a imagem é do MATERIAL (id): nome igual, mesmo tipo ou mesmo GHE não propagam a imagem a outros materiais', async () => {
      const img = await imagemDaEmpresa();
      const m1 = await criarMaterial({ nome: 'Luva igual ISO04', imagem: { origem: 'EMPRESA', id: img.id } });
      const m2 = await criarMaterial({ nome: 'Luva igual ISO04 b' });
      const { gheId } = await a.funcionarioComMaterial(A, [m1.id, m2.id]);
      assert.ok(gheId > 0);
      assert.deepEqual(await colunas(m2.id), { imagem_padrao_id: null, imagem_empresa_id: null });
      assert.equal(await a.contagem('materiais', 'imagem_empresa_id = $1', [img.id]), 1);
    });
  });

  describe('[VAL] formato do campo `imagem`', () => {
    test('VAL-01: `imagem` malformada é 400 VALIDACAO em body.imagem e nada é gravado (origem em minúsculas, id não inteiro/zero/negativo, chave extra, tipo errado, array, string)', async () => {
      const m = await criarMaterial();
      const logs = await a.contagem('logs_auditoria');
      // Ajuste V7: o id BIGINT é texto decimal canônico (ou inteiro seguro): "5" É válido agora; recusa-se zero, negativo, zeros à esquerda, não
      // numérico, vazio, fracionário, número acima de 2^53 e texto acima de 2^63-1.
      const invalidas = [
        { origem: 'empresa', id: 1 }, { origem: 'OUTRA', id: 1 }, { origem: 'EMPRESA', id: 0 }, { origem: 'EMPRESA', id: -3 }, { origem: 'EMPRESA', id: '0' },
        { origem: 'EMPRESA', id: '05' }, { origem: 'EMPRESA', id: 'abc' }, { origem: 'EMPRESA', id: '' }, { origem: 'EMPRESA', id: '-5' }, { origem: 'EMPRESA', id: '1.5' },
        { origem: 'EMPRESA', id: '9223372036854775808' }, { origem: 'EMPRESA', id: 9007199254740993 },
        { origem: 'EMPRESA', id: 1.5 }, { origem: 'EMPRESA', id: 1, caminho: '/x' }, { origem: 'EMPRESA', id: 1, versao: 2 }, { origem: 'EMPRESA', id: 1, zz: 1 }, { origem: 'EMPRESA' }, { id: 1 }, [], 'x', 7, true,
      ];
      for (const imagem of invalidas) {
        const e = await alterar(m.id, { imagem }).then(() => null, (erro) => erro);
        assert.ok(e && e.status === 400 && e.codigo === 'VALIDACAO', `deveria recusar ${JSON.stringify(imagem)}`);
        assert.equal(e.detalhes.some((d) => d.campo === 'body.imagem'), true);
      }
      assert.equal(await a.contagem('logs_auditoria'), logs);
      assert.deepEqual(await colunas(m.id), { imagem_padrao_id: null, imagem_empresa_id: null });
    });
  });

  describe('[IDS] id BIGINT: texto decimal em todo o contrato', () => {
    test('IDS-01: o id entra como texto decimal ou como inteiro seguro (equivalentes) e sai SEMPRE como texto, na resposta e na auditoria; id inexistente acima de 2^53 é 404 uniforme (sem erro de conversão)', async () => {
      const img = await imagemDaEmpresa();
      assert.equal(typeof img.id, 'string');
      const m1 = await criarMaterial({ imagem: { origem: 'EMPRESA', id: img.id } });
      const m2 = await criarMaterial({ imagem: { origem: 'EMPRESA', id: Number(img.id) } });
      for (const m of [m1, m2]) {
        assert.equal(typeof m.imagem.id, 'string');
        assert.equal(m.imagem.id, img.id);
      }
      const log = (await a.auditoria('MATERIAL_CRIADO', A)).find((l) => l.referencia === String(m2.id));
      assert.equal(log.dados_novos.imagem.id, img.id);
      await esperarErro(alterar(m1.id, { imagem: { origem: 'EMPRESA', id: '9007199254740993' } }), ...IMAGEM_NAO_ENCONTRADA);
      await esperarErro(alterar(m1.id, { imagem: { origem: 'PADRAO', id: '9223372036854775807' } }), ...IMAGEM_NAO_ENCONTRADA);
    });
  });

  describe('[LER] leitura do material com a imagem', () => {
    test('LER-01: buscar e listar trazem `imagem` (null ou {origem,id,versao,nome}); a leitura é por empresa e não expõe campos internos', async () => {
      const img = await imagemDaEmpresa();
      const m = await criarMaterial({ nome: 'Material LER01', imagem: { origem: 'EMPRESA', id: img.id } });
      const sem = await criarMaterial({ nome: 'Material LER01 sem' });
      const b = await materialService.buscar(a.pool, { empresaId: A, materialId: m.id });
      assert.deepEqual(b.imagem, { origem: 'EMPRESA', id: img.id, versao: 1, nome: img.nome });
      assert.equal((await materialService.buscar(a.pool, { empresaId: A, materialId: sem.id })).imagem, null);
      const l = await materialService.listar(a.pool, { empresaId: A, busca: 'Material LER01', limite: 50 });
      assert.deepEqual(l.materiais.map((x) => [x.id, x.imagem === null ? null : x.imagem.id]).sort((x, y) => x[0] - y[0]), [[m.id, img.id], [sem.id, null]]);
    });

    test('LER-02: o repositório devolve a imagem de vários materiais de uma vez (um por material), só da empresa informada, e só imagem ATIVA conta como "disponível"', async () => {
      const img = await imagemDaEmpresa();
      const p = await a.padrao({ nome: 'Padrão LER02' });
      const m1 = await criarMaterial({ imagem: { origem: 'EMPRESA', id: img.id } });
      const m2 = await criarMaterial({ imagem: { origem: 'PADRAO', id: p.id } });
      const m3 = await criarMaterial();
      const mapa = await materialImagemRepo().obterPorMateriais(a.pool, A, [m1.id, m2.id, m3.id]);
      assert.deepEqual([...mapa.entries()].map(([id, v]) => [id, v.origem, v.id]).sort((x, y) => x[0] - y[0]), [[m1.id, 'EMPRESA', img.id], [m2.id, 'PADRAO', p.id]].sort((x, y) => x[0] - y[0]));
      assert.equal((await materialImagemRepo().obterPorMateriais(a.pool, B, [m1.id, m2.id])).size, 0, 'outra empresa não enxerga');
    });
  });

  describe('[TRV] ordem de travas material → imagem e concorrência com a inativação', () => {
    const esperarBloqueio = (pid) => a.esperarBloqueio(pid);

    test('TRV-01: associação em andamento segura a imagem (FOR SHARE): a inativação concorrente ESPERA e, ao concluir, é recusada com 409 IMAGEM_EM_USO; o vínculo permanece', async () => {
      const img = await imagemDaEmpresa();
      const m = await criarMaterial();
      const c = await a.pool.connect();
      try {
        await c.query('BEGIN');
        const { rows: [{ pid }] } = await c.query('SELECT pg_backend_pid() AS pid');
        await materialRepo.buscarPorIdParaAtualizacao(c, A, m.id);
        const travada = await imagemEmpresaRepo().buscarPorIdParaAssociacao(c, A, img.id);
        assert.equal(travada.estado, 'ATIVA');
        const inativacao = biblioteca().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: img.id }).then(() => null, (e) => e);
        await esperarBloqueio(pid);
        await materialImagemRepo().definir(c, A, m.id, { imagemPadraoId: null, imagemEmpresaId: img.id });
        await c.query('COMMIT');
        const erro = await inativacao;
        assert.deepEqual([erro.status, erro.codigo], [409, 'IMAGEM_EM_USO']);
      } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
      assert.equal((await colunas(m.id)).imagem_empresa_id, img.id);
      assert.equal((await a.q('SELECT estado FROM imagens_empresa WHERE id = $1', [img.id])).rows[0].estado, 'ATIVA');
    });

    test('TRV-02: inativação em andamento segura a imagem (FOR UPDATE): a associação concorrente ESPERA e, ao concluir, é recusada (404 uniforme) sem gravar nada no material', async () => {
      const img = await imagemDaEmpresa();
      const m = await criarMaterial();
      const c = await a.pool.connect();
      try {
        await c.query('BEGIN');
        const { rows: [{ pid }] } = await c.query('SELECT pg_backend_pid() AS pid');
        await imagemEmpresaRepo().buscarPorIdParaAtualizacao(c, A, img.id);
        const associacao = alterar(m.id, { nome: 'Não pode ficar TRV02', imagem: { origem: 'EMPRESA', id: img.id } }).then(() => null, (e) => e);
        await esperarBloqueio(pid);
        await imagemEmpresaRepo().atualizarEstado(c, A, img.id, 'INATIVA');
        await c.query('COMMIT');
        const erro = await associacao;
        assert.deepEqual([erro.status, erro.codigo], IMAGEM_NAO_ENCONTRADA);
      } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
      assert.deepEqual(await colunas(m.id), { imagem_padrao_id: null, imagem_empresa_id: null });
      assert.notEqual((await a.linhaDoMaterial(m.id)).nome, 'Não pode ficar TRV02');
    });

    test('TRV-03: duas associações da MESMA imagem a materiais diferentes não se bloqueiam (FOR SHARE com FOR SHARE) e ambas concluem', async () => {
      const img = await imagemDaEmpresa();
      const [m1, m2] = [await criarMaterial(), await criarMaterial()];
      const c = await a.pool.connect();
      try {
        await c.query('BEGIN');
        await imagemEmpresaRepo().buscarPorIdParaAssociacao(c, A, img.id);
        await alterar(m2.id, { imagem: { origem: 'EMPRESA', id: img.id } });
        await materialImagemRepo().definir(c, A, m1.id, { imagemPadraoId: null, imagemEmpresaId: img.id });
        await c.query('COMMIT');
      } finally { await c.query('ROLLBACK').catch(() => {}); c.release(); }
      assert.equal(await a.contagem('materiais', 'imagem_empresa_id = $1', [img.id]), 2);
    });

    test('TRV-04: associações e inativações misturadas e simultâneas terminam todas (sem deadlock) e o resultado é coerente: nunca uma imagem INATIVA referenciada por material', async () => {
      const imagens = [await imagemDaEmpresa(), await imagemDaEmpresa(), await imagemDaEmpresa()];
      const materiais = [await criarMaterial(), await criarMaterial(), await criarMaterial(), await criarMaterial()];
      const tarefas = [];
      for (const [i, img] of imagens.entries()) {
        for (const m of materiais) tarefas.push(alterar(m.id, { imagem: { origem: 'EMPRESA', id: img.id } }));
        tarefas.push(biblioteca().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: img.id }));
        if (i === 1) tarefas.push(biblioteca().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: img.id }));
      }
      const limite = new Promise((_, rejeitar) => { setTimeout(() => rejeitar(new Error('deadlock ou espera indefinida')), 20000); });
      const resultados = await Promise.race([Promise.allSettled(tarefas), limite]);
      for (const r of resultados) {
        if (r.status === 'rejected') assert.ok([404, 409].includes(r.reason.status), `erro inesperado: ${r.reason.status} ${r.reason.codigo} ${r.reason.message}`);
      }
      const violacoes = await a.q(
        `SELECT count(*)::int AS n FROM materiais m JOIN imagens_empresa i ON i.empresa_id = m.empresa_id AND i.id = m.imagem_empresa_id WHERE i.estado = 'INATIVA' AND i.id = ANY($1)`,
        [imagens.map((i) => i.id)],
      );
      assert.equal(violacoes.rows[0].n, 0);
    });
  });

  describe('[REG] preservação das regras existentes do cadastro de materiais', () => {
    test('REG-01: criar/alterar SEM imagem se comporta como hoje — mesmas colunas da resposta e auditoria sem chave de imagem', async () => {
      const m = await criarMaterial({ nome: 'Material REG01' });
      const log = (await a.auditoria('MATERIAL_CRIADO', A)).find((l) => l.referencia === String(m.id));
      assert.equal('imagem' in log.dados_novos, false);
      const { imagem, ...resto } = m;
      assert.equal(imagem, null);
      for (const chave of ['id', 'empresaId', 'nome', 'tipo', 'unidade', 'estoqueMinimo', 'categoria', 'exigeTamanho', 'ativo', 'modeloClassificacao', 'grupoProtecao', 'tipoMaterialId', 'tamanhos']) assert.ok(chave in resto, `a chave ${chave} continua na resposta`);
    });

    test('REG-02: inativar e reativar o MATERIAL continuam funcionando e não mexem na imagem associada', async () => {
      const img = await imagemDaEmpresa();
      const m = await criarMaterial({ imagem: { origem: 'EMPRESA', id: img.id } });
      await materialService.inativar(a.pool, { empresaId: A, atorId: ATOR_A, materialId: m.id });
      await materialService.reativar(a.pool, { empresaId: A, atorId: ATOR_A, materialId: m.id });
      assert.equal((await colunas(m.id)).imagem_empresa_id, img.id);
    });

    test('REG-03: o banco continua sendo a última barreira — SQL direto com imagem de outra empresa ou duas imagens é recusado (FK composta e CHECK da 090)', async () => {
      const deB = await imagemDaEmpresa(B, ATOR_B);
      const m = await criarMaterial();
      await assert.rejects(a.q('UPDATE materiais SET imagem_empresa_id = $2 WHERE id = $1', [m.id, deB.id]), (e) => e.code === '23503');
      const p = await a.padrao({ nome: 'Padrão REG03' });
      const proprio = await imagemDaEmpresa();
      await assert.rejects(a.q('UPDATE materiais SET imagem_empresa_id = $2, imagem_padrao_id = $3 WHERE id = $1', [m.id, proprio.id, p.id]), (e) => e.code === '23514');
    });
  });
});
