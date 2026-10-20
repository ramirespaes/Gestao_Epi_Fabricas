'use strict';

const { describe, test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { abrirAmbienteImagens, descritor } = require('./helpers/imagem-material');
const { exigirModulo } = require('../helpers/exigir-modulo');

/**
 * Biblioteca de Imagens, Unidade 3 (RED) — serviço e repositórios da BIBLIOTECA: consulta das imagens padrão e das imagens privadas da empresa,
 * isolamento entre empresas, deduplicação por SHA-256, cota, inativação com 409 e auditoria. Sem HTTP, sem tela, sem processamento de imagem
 * (o serviço recebe o descritor de uma imagem JÁ processada), sem importar as 30 imagens reais.
 *
 * PostgreSQL real, banco de teste exclusivo, schema temporário exclusivo com todas as migrations (090 incluída). Hoje todos falham pela
 * ausência dos módulos (`src/services/imagem-material.service.js` e os repositórios); nenhum falha por quebra do próprio harness.
 *
 * [DECISÃO] marca o que o teste ASSUME e a V7 precisa confirmar no GREEN.
 */

const servico = () => exigirModulo('src/services/imagem-material.service');
const CAMPOS_INTERNOS = ['sha256', 'sha256Mestre', 'sha256Exibicao', 'sha256Miniatura', 'bytesMestre', 'bytesExibicao', 'bytesMiniatura', 'empresaId', 'criadoPor', 'caminho', 'chave', 'arquivoOrigem', 'pacoteOrigem'];

async function esperarErro(promessa, status, codigo) {
  await assert.rejects(promessa, (erro) => {
    assert.equal(erro.status, status, `status ${erro.status} ${erro.codigo}`);
    assert.equal(erro.codigo, codigo);
    return true;
  });
}
const semInternos = (lista) => { for (const i of lista) for (const c of CAMPOS_INTERNOS) assert.equal(c in i, false, `campo interno exposto: ${c}`); };
const nomes = (r) => r.imagens.map((i) => i.nome);

describe('Biblioteca de Imagens — consulta, isolamento, deduplicação, cota, inativação e auditoria (PostgreSQL real)', () => {
  let a;
  let A;
  let B;
  let ATOR_A;
  let ATOR_A2;
  let ATOR_B;

  before(async () => {
    a = await abrirAmbienteImagens();
    ({ empresaA: A, empresaB: B, atorA: ATOR_A, atorA2: ATOR_A2, atorB: ATOR_B } = a.d);
  });
  after(async () => { if (a) await a.encerrar(); });

  const registrar = (extra = {}) => servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'Imagem de teste', imagem: descritor(), ...extra });

  describe('[LST] imagens padrão SafeWork (biblioteca global, somente leitura para a empresa)', () => {
    test('LST-01: a origem PADRAO lista só imagens padrão ATIVAS, marcadas como ilustrativas, sem nenhum campo interno', async () => {
      const ativa = await a.padrao({ nome: 'Padrão ativa LST01' });
      // A inativa ordena ANTES da ativa (mutação M11): se a listagem não filtrasse `ativo`, ela ocuparia a primeira posição e apareceria.
      const inativa = await a.padrao({ nome: 'A padrão inativa LST01', ativo: false });
      const r = await servico().listar(a.pool, { empresaId: A, origem: 'PADRAO', busca: 'LST01' });
      assert.deepEqual(nomes(r), ['Padrão ativa LST01']);
      assert.equal(r.imagens[0].origem, 'PADRAO');
      assert.equal(r.imagens[0].id, ativa.id);
      assert.equal(typeof r.imagens[0].id, 'string', 'o id BIGINT circula como texto decimal (V7), sem perder precisão');
      assert.match(r.imagens[0].id, /^[1-9][0-9]*$/);
      assert.equal(typeof r.imagens[0].emUso, 'number');
      assert.equal(r.imagens[0].ilustrativa, true);
      assert.equal(r.imagens.some((i) => i.id === inativa.id), false);
      assert.equal(r.total, 1);
      semInternos(r.imagens);
    });

    test('LST-02: a mesma biblioteca padrão aparece para qualquer empresa (é global), mas o "emUso" só conta os materiais da PRÓPRIA empresa', async () => {
      const p = await a.padrao({ nome: 'Padrão compartilhada LST02' });
      const mA = await a.material(A, 'Material A LST02');
      const mB = await a.material(B, 'Material B LST02');
      await a.q('UPDATE materiais SET imagem_padrao_id = $2 WHERE id = $1', [mA, p.id]);
      await a.q('UPDATE materiais SET imagem_padrao_id = $2 WHERE id = $1', [mB, p.id]);
      const mB2 = await a.material(B, 'Material B2 LST02');
      await a.q('UPDATE materiais SET imagem_padrao_id = $2 WHERE id = $1', [mB2, p.id]);
      const ver = async (empresaId) => (await servico().listar(a.pool, { empresaId, origem: 'PADRAO', busca: 'LST02' })).imagens.find((i) => i.id === p.id);
      assert.equal((await ver(A)).emUso, 1, 'A vê só o uso da própria empresa');
      assert.equal((await ver(B)).emUso, 2, 'B vê só o uso da própria empresa');
    });

    test('LST-03: busca por nome sem diferenciar maiúsculas e acentos; coringas do LIKE são texto literal', async () => {
      await a.padrao({ nome: 'Óculos de Proteção LST03' });
      await a.padrao({ nome: 'Luva 100% nitrílica LST03' });
      assert.deepEqual(nomes(await servico().listar(a.pool, { empresaId: A, origem: 'PADRAO', busca: 'oculos de protecao lst03' })), ['Óculos de Proteção LST03']);
      assert.deepEqual(nomes(await servico().listar(a.pool, { empresaId: A, origem: 'PADRAO', busca: '100% nitr' })), ['Luva 100% nitrílica LST03']);
      assert.deepEqual(nomes(await servico().listar(a.pool, { empresaId: A, origem: 'PADRAO', busca: '%' })).filter((n) => !n.includes('%')), [], 'o % não vira coringa');
      assert.deepEqual((await servico().listar(a.pool, { empresaId: A, origem: 'PADRAO', busca: 'inexistente-xyz' })).imagens, []);
    });

    test('LST-04: "sugerida" só destaca (PRINCIPAL antes de ALTERNATIVA, depois as demais) e só quando o tipo é informado; nada é associado sozinho', async () => {
      const outra = await a.padrao({ nome: 'Zeta sem sugestão LST04' });
      const alt = await a.padrao({ nome: 'Beta alternativa LST04' });
      const princ = await a.padrao({ nome: 'Gama principal LST04' });
      await a.sugestao(alt.id, 'Tipo LST04', 'ALTERNATIVA');
      await a.sugestao(princ.id, 'Tipo LST04', 'PRINCIPAL');
      const antes = await a.contagem('materiais', 'imagem_padrao_id IS NOT NULL OR imagem_empresa_id IS NOT NULL');
      const com = await servico().listar(a.pool, { empresaId: A, origem: 'PADRAO', busca: 'LST04', tipoNome: 'Tipo LST04' });
      assert.deepEqual(com.imagens.map((i) => [i.id, i.sugerida]), [[princ.id, 'PRINCIPAL'], [alt.id, 'ALTERNATIVA'], [outra.id, null]]);
      const sem = await servico().listar(a.pool, { empresaId: A, origem: 'PADRAO', busca: 'LST04' });
      assert.deepEqual(sem.imagens.map((i) => i.sugerida), [null, null, null], 'sem tipo informado nada é destacado');
      assert.deepEqual(sem.imagens.map((i) => i.nome), ['Beta alternativa LST04', 'Gama principal LST04', 'Zeta sem sugestão LST04'], 'ordem estável por nome');
      assert.equal(await a.contagem('materiais', 'imagem_padrao_id IS NOT NULL OR imagem_empresa_id IS NOT NULL'), antes, 'consultar não cria vínculo');
    });
  });

  describe('[LST] biblioteca privada da empresa e isolamento', () => {
    test('LST-05: a origem EMPRESA lista só as imagens ATIVAS da empresa autenticada; as de outra empresa nunca aparecem, nem por busca', async () => {
      const ra = await registrar({ nome: 'Da A LST05', imagem: descritor() });
      const rb = await servico().registrarEmpresa(a.pool, { empresaId: B, atorId: ATOR_B, nome: 'Da B LST05', imagem: descritor() });
      const lista = async (empresaId) => servico().listar(a.pool, { empresaId, origem: 'EMPRESA', busca: 'LST05' });
      assert.deepEqual((await lista(A)).imagens.map((i) => i.id), [ra.imagem.id]);
      assert.deepEqual((await lista(B)).imagens.map((i) => i.id), [rb.imagem.id]);
      assert.equal((await lista(A)).imagens[0].origem, 'EMPRESA');
      assert.equal((await lista(A)).total, 1);
      semInternos((await lista(A)).imagens);
    });

    test('LST-06: imagem INATIVA não é listada por padrão e aparece, com estado, quando o estado é pedido (gestão)', async () => {
      const r = await registrar({ nome: 'Para inativar LST06', imagem: descritor() });
      await servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id });
      assert.deepEqual((await servico().listar(a.pool, { empresaId: A, origem: 'EMPRESA', busca: 'LST06' })).imagens, []);
      const gestao = await servico().listar(a.pool, { empresaId: A, origem: 'EMPRESA', busca: 'LST06', estado: 'TODAS' });
      assert.deepEqual(gestao.imagens.map((i) => [i.id, i.estado]), [[r.imagem.id, 'INATIVA']]);
    });

    test('LST-07: TODAS = padrão (primeiro) + imagens da empresa, com total somado e paginação estável entre as duas origens; nenhuma é selecionada', async () => {
      const p1 = await a.padrao({ nome: 'T1 padrão LST07' });
      const p2 = await a.padrao({ nome: 'T2 padrão LST07' });
      const e1 = await registrar({ nome: 'T3 empresa LST07', imagem: descritor() });
      const e2 = await registrar({ nome: 'T4 empresa LST07', imagem: descritor() });
      const todas = await servico().listar(a.pool, { empresaId: A, origem: 'TODAS', busca: 'LST07', pagina: 1, limite: 100 });
      assert.deepEqual(todas.imagens.map((i) => [i.origem, i.id]), [['PADRAO', p1.id], ['PADRAO', p2.id], ['EMPRESA', e1.imagem.id], ['EMPRESA', e2.imagem.id]]);
      assert.equal(todas.total, 4);
      const p1a = await servico().listar(a.pool, { empresaId: A, origem: 'TODAS', busca: 'LST07', pagina: 1, limite: 3 });
      const p2a = await servico().listar(a.pool, { empresaId: A, origem: 'TODAS', busca: 'LST07', pagina: 2, limite: 3 });
      assert.deepEqual([...p1a.imagens, ...p2a.imagens].map((i) => [i.origem, i.id]), todas.imagens.map((i) => [i.origem, i.id]));
      assert.deepEqual([p1a.imagens.length, p2a.imagens.length, p1a.total, p2a.total], [3, 1, 4, 4]);
      assert.equal(todas.imagens.some((i) => 'selecionada' in i), false, 'nada vem selecionado');
    });

    test('LST-08: a listagem não cria, altera nem remove nada (somente leitura)', async () => {
      const antes = [await a.contagem('imagens_empresa'), await a.contagem('imagens_padrao'), await a.contagem('logs_auditoria')];
      await servico().listar(a.pool, { empresaId: A, origem: 'TODAS' });
      assert.deepEqual([await a.contagem('imagens_empresa'), await a.contagem('imagens_padrao'), await a.contagem('logs_auditoria')], antes);
    });

    test('LST-09: empresa vem sempre do contexto: id inválido é erro de programação e origem desconhecida é recusada', async () => {
      await assert.rejects(servico().listar(a.pool, { empresaId: 'abc', origem: 'TODAS' }), TypeError);
      await assert.rejects(servico().listar(a.pool, { empresaId: A, origem: 'OUTRA' }), (e) => e instanceof TypeError || e.status === 400);
    });
  });

  describe('[REG] registro na biblioteca da empresa: deduplicação por SHA-256, cota e validação', () => {
    test('REG-01: registra a imagem nova (reaproveitada=false), ATIVA, versão 1, com empresa e criador da sessão, sem campos internos na resposta', async () => {
      const d = descritor();
      const r = await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A2, nome: '  Luva REG01  ', imagem: d });
      assert.equal(r.reaproveitada, false);
      assert.equal(typeof r.imagem.id, 'string', 'o id (BIGINT no banco) sai como texto decimal, nunca como Number (V7)');
      assert.equal(r.imagem.nome, 'Luva REG01', 'nome aparado');
      assert.equal(r.imagem.estado, 'ATIVA');
      assert.equal(r.imagem.versao, 1);
      assert.equal(r.imagem.origem, 'EMPRESA');
      semInternos([r.imagem]);
      const linha = (await a.q('SELECT * FROM imagens_empresa WHERE id = $1', [r.imagem.id])).rows[0];
      assert.deepEqual([linha.empresa_id, linha.criado_por, linha.sha256, linha.estado], [A, ATOR_A2, d.sha256, 'ATIVA']);
    });

    test('REG-02: o mesmo SHA-256 na mesma empresa NÃO duplica: devolve a existente (reaproveitada=true), preserva o nome original e não audita de novo', async () => {
      const d = descritor();
      const primeira = await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'Original REG02', imagem: d });
      const segunda = await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A2, nome: 'Outro nome REG02', imagem: d });
      assert.equal(segunda.reaproveitada, true);
      assert.equal(segunda.imagem.id, primeira.imagem.id);
      assert.equal(segunda.imagem.nome, 'Original REG02');
      assert.equal(await a.contagem('imagens_empresa', 'sha256 = $1', [d.sha256]), 1);
      assert.equal((await a.auditoria('IMAGEM_MATERIAL_IMPORTADA', A)).filter((l) => l.referencia === String(primeira.imagem.id)).length, 1);
    });

    test('REG-03: o mesmo SHA-256 em OUTRA empresa é outra imagem (a deduplicação é por empresa, nunca entre empresas)', async () => {
      const d = descritor();
      const ra = await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'REG03', imagem: d });
      const rb = await servico().registrarEmpresa(a.pool, { empresaId: B, atorId: ATOR_B, nome: 'REG03', imagem: d });
      assert.equal(rb.reaproveitada, false);
      assert.notEqual(rb.imagem.id, ra.imagem.id);
      assert.deepEqual((await a.q('SELECT empresa_id FROM imagens_empresa WHERE sha256 = $1 ORDER BY empresa_id', [d.sha256])).rows.map((x) => x.empresa_id), [A, B]);
    });

    test('REG-04 [DECISÃO]: reenvio de imagem já existente mas INATIVA devolve a existente com o estado dela e NÃO a reativa em silêncio (reativar é operação própria, de editar)', async () => {
      const d = descritor();
      const r = await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'REG04', imagem: d });
      await servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id });
      const de_novo = await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'REG04', imagem: d });
      assert.equal(de_novo.reaproveitada, true);
      assert.equal(de_novo.imagem.id, r.imagem.id);
      assert.equal(de_novo.imagem.estado, 'INATIVA');
      assert.equal((await a.q('SELECT estado FROM imagens_empresa WHERE id = $1', [r.imagem.id])).rows[0].estado, 'INATIVA');
      assert.equal(await a.contagem('imagens_empresa', 'sha256 = $1', [d.sha256]), 1);
    });

    test('REG-05: concorrência — oito envios simultâneos do mesmo arquivo viram UMA linha, uma auditoria, um "novo" e sete "reaproveitada"', async () => {
      const d = descritor();
      const resultados = await Promise.all(Array.from({ length: 8 }, (_, i) => servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: `REG05 ${i}`, imagem: d })));
      assert.equal(await a.contagem('imagens_empresa', 'sha256 = $1', [d.sha256]), 1);
      assert.equal(new Set(resultados.map((r) => r.imagem.id)).size, 1);
      assert.deepEqual([resultados.filter((r) => !r.reaproveitada).length, resultados.filter((r) => r.reaproveitada).length], [1, 7]);
      const id = String(resultados[0].imagem.id);
      assert.equal((await a.auditoria('IMAGEM_MATERIAL_IMPORTADA', A)).filter((l) => l.referencia === id).length, 1);
    });

    test('REG-06: a cota de imagens é serializada — cinco imagens diferentes disputando as 3 últimas vagas: três passam, duas recebem 409 IMAGEM_COTA_EXCEDIDA e nada fica a mais', async () => {
      const antes = await a.contagem('imagens_empresa', 'empresa_id = $1', [A]);
      const limites = { cotaImagens: antes + 3, cotaBytes: 1024 * 1024 * 1024 };
      const r = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: `REG06 ${i}`, imagem: descritor(), limites })));
      assert.equal(r.filter((x) => x.status === 'fulfilled').length, 3);
      const recusadas = r.filter((x) => x.status === 'rejected');
      assert.equal(recusadas.length, 2);
      for (const x of recusadas) { assert.equal(x.reason.status, 409); assert.equal(x.reason.codigo, 'IMAGEM_COTA_EXCEDIDA'); }
      assert.equal(await a.contagem('imagens_empresa', 'empresa_id = $1', [A]), antes + 3);
    });

    // Ajuste V7: a cota em bytes é a documentada (docs. 04 e 13: "300 MiB somando os MESTRES"; as derivadas somam por fora) e conta também as
    // imagens INATIVAS até a remoção controlada. A deduplicação nunca conta duas vezes (uma linha por conteúdo).
    test('REG-07: a cota em bytes soma os MESTRES de todas as imagens da empresa (inclusive as inativas); acima do limite é 409 e nada é gravado', async () => {
      const inativa = await registrar({ nome: 'REG07 inativa', imagem: descritor({ bytesMestre: 70000 }) });
      await servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: inativa.imagem.id });
      const ocupado = Number((await a.q('SELECT COALESCE(sum(bytes_mestre), 0)::bigint AS n FROM imagens_empresa WHERE empresa_id = $1', [A])).rows[0].n);
      const limites = { cotaImagens: 5000, cotaBytes: ocupado + 100000 };
      const antes = await a.contagem('imagens_empresa', 'empresa_id = $1', [A]);
      await esperarErro(servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'REG07 grande', imagem: descritor({ bytesMestre: 100001, bytesExibicao: 10, bytesMiniatura: 10 }), limites }), 409, 'IMAGEM_COTA_EXCEDIDA');
      assert.equal(await a.contagem('imagens_empresa', 'empresa_id = $1', [A]), antes);
      const ok = await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'REG07 cabe', imagem: descritor({ bytesMestre: 100000, bytesExibicao: 90000, bytesMiniatura: 90000 }), limites });
      assert.equal(ok.reaproveitada, false, 'as derivadas não entram na cota: só o mestre (100000) coube no que faltava');
    });

    test('REG-07b: a deduplicação não conta bytes duas vezes — reenviar o mesmo conteúdo (inclusive de imagem inativa) não aumenta o consumo da cota', async () => {
      const d = descritor({ bytesMestre: 12345 });
      const r = await registrar({ nome: 'REG07b', imagem: d });
      const consumo = async () => (await a.q('SELECT count(*)::int AS n, COALESCE(sum(bytes_mestre), 0)::bigint AS b FROM imagens_empresa WHERE empresa_id = $1', [A])).rows[0];
      const antes = await consumo();
      await registrar({ nome: 'REG07b outra vez', imagem: d });
      await servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id });
      await registrar({ nome: 'REG07b inativa', imagem: d });
      assert.deepEqual(await consumo(), antes);
    });

    test('REG-08: reaproveitar uma imagem já existente não consome cota (mesmo com a cota cheia)', async () => {
      const d = descritor();
      await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'REG08', imagem: d });
      const total = await a.contagem('imagens_empresa', 'empresa_id = $1', [A]);
      const r = await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A, nome: 'REG08', imagem: d, limites: { cotaImagens: total, cotaBytes: 1024 * 1024 * 1024 } });
      assert.equal(r.reaproveitada, true);
    });

    test('REG-09: dados inválidos são recusados (400 VALIDACAO) sem gravar nada: SHA-256 fora do formato, nome vazio/longo/com controle, formato não aceito, lado fora de 320–4096', async () => {
      const antes = [await a.contagem('imagens_empresa'), await a.contagem('logs_auditoria')];
      const casos = [
        { imagem: descritor({ sha256: 'ABCDEF'.repeat(10) + 'abcd' }) },
        { imagem: descritor({ sha256: 'a'.repeat(63) }) },
        { imagem: descritor({ sha256Miniatura: 'z'.repeat(64) }) },
        { nome: '   ' },
        { nome: 'x'.repeat(101) },
        { nome: 'com\u0000controle' },
        { imagem: descritor({ formato: 'GIF' }) },
        { imagem: descritor({ formato: 'png' }) },
        { imagem: descritor({ largura: 319 }) },
        { imagem: descritor({ altura: 4097 }) },
        { imagem: descritor({ bytesMestre: 0 }) },
      ];
      for (const extra of casos) {
        await assert.rejects(registrar(extra), (e) => { assert.equal(e.status, 400); assert.equal(e.codigo, 'VALIDACAO'); return true; }, JSON.stringify(extra).slice(0, 60));
      }
      assert.deepEqual([await a.contagem('imagens_empresa'), await a.contagem('logs_auditoria')], antes);
    });

    test('REG-10: o nome é só texto de exibição (NFC, 1 a 100); empresa e ator inválidos são erro de programação', async () => {
      const r = await registrar({ nome: 'Cápsula REG10' });
      assert.equal(r.imagem.nome, 'Cápsula REG10');
      await assert.rejects(registrar({ empresaId: 0 }), TypeError);
      await assert.rejects(registrar({ atorId: '7' }), TypeError);
    });

    test('REG-11: o ator precisa ser da empresa (a FK composta do banco é a última barreira): ator de outra empresa não registra e nada fica', async () => {
      const antes = await a.contagem('imagens_empresa');
      await assert.rejects(servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_B, nome: 'REG11', imagem: descritor() }));
      assert.equal(await a.contagem('imagens_empresa'), antes);
    });
  });

  describe('[AUD] auditoria da biblioteca: só ids, formato e bytes; nunca nome, hash, caminho, chave ou conteúdo', () => {
    test('AUD-01: o registro grava UMA linha IMAGEM_MATERIAL_IMPORTADA na mesma transação, com o ator e a empresa corretos', async () => {
      const d = descritor();
      const r = await servico().registrarEmpresa(a.pool, { empresaId: A, atorId: ATOR_A2, nome: 'Nome secreto AUD01', imagem: d, ip: '203.0.113.9', dispositivo: 'teste' });
      const linhas = (await a.auditoria('IMAGEM_MATERIAL_IMPORTADA', A)).filter((l) => l.referencia === String(r.imagem.id));
      assert.equal(linhas.length, 1);
      assert.equal(linhas[0].usuario_id, ATOR_A2);
      assert.equal(linhas[0].contexto.imagemId, r.imagem.id);
      assert.equal(linhas[0].contexto.formato, 'PNG');
      assert.equal(linhas[0].contexto.bytes, 90000 + 40000 + 9000);
      const bruto = JSON.stringify([linhas[0].contexto, linhas[0].dados_anteriores, linhas[0].dados_novos, linhas[0].descricao]);
      for (const proibido of ['Nome secreto', d.sha256, d.sha256Mestre, d.sha256Exibicao, d.sha256Miniatura, 'caminho', 'chave']) assert.equal(bruto.includes(proibido), false, `auditoria vazou ${proibido}`);
    });

    test('AUD-02: renomear, inativar e reativar auditam (RENOMEADA, INATIVADA, REATIVADA) só com ids; repetir o mesmo estado não audita', async () => {
      const r = await registrar({ nome: 'Antes AUD02', imagem: descritor() });
      const id = String(r.imagem.id);
      const conta = async (acao) => (await a.auditoria(acao, A)).filter((l) => l.referencia === id);
      await servico().renomear(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id, nome: 'Depois AUD02' });
      await servico().renomear(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id, nome: 'Depois AUD02' });
      await servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id });
      await servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id });
      await servico().reativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id });
      await servico().reativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id });
      assert.deepEqual([(await conta('IMAGEM_MATERIAL_RENOMEADA')).length, (await conta('IMAGEM_MATERIAL_INATIVADA')).length, (await conta('IMAGEM_MATERIAL_REATIVADA')).length], [1, 1, 1]);
      const bruto = JSON.stringify([...(await conta('IMAGEM_MATERIAL_RENOMEADA')), ...(await conta('IMAGEM_MATERIAL_INATIVADA')), ...(await conta('IMAGEM_MATERIAL_REATIVADA'))].map((l) => [l.contexto, l.dados_anteriores, l.dados_novos]));
      assert.equal(bruto.includes('Antes AUD02') || bruto.includes('Depois AUD02'), false, 'o nome da imagem não vai para a auditoria');
    });

    test('AUD-03: nenhuma recusa (validação, cota, 404, 409) deixa linha de auditoria nem imagem para trás', async () => {
      const r = await registrar({ nome: 'AUD03', imagem: descritor() });
      const m = await a.material(A, 'Material AUD03');
      await a.q('UPDATE materiais SET imagem_empresa_id = $2 WHERE id = $1', [m, r.imagem.id]);
      const antes = await a.contagem('logs_auditoria');
      await assert.rejects(servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id }));
      await assert.rejects(servico().renomear(a.pool, { empresaId: B, atorId: ATOR_B, imagemId: r.imagem.id, nome: 'x' }));
      await assert.rejects(registrar({ nome: '', imagem: descritor() }));
      assert.equal(await a.contagem('logs_auditoria'), antes);
    });
  });

  describe('[CIC] renomear, inativar (409 se em uso) e reativar', () => {
    test('CIC-01: renomear troca só o nome (a versão do arquivo não muda); mesmo nome é no-op (alterado=false)', async () => {
      const r = await registrar({ nome: 'CIC01 antes', imagem: descritor() });
      const x = await servico().renomear(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id, nome: '  CIC01 depois ' });
      assert.deepEqual([x.alterado, x.imagem.nome, x.imagem.versao], [true, 'CIC01 depois', 1]);
      const y = await servico().renomear(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id, nome: 'CIC01 depois' });
      assert.equal(y.alterado, false);
      await assert.rejects(servico().renomear(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id, nome: '' }), (e) => e.status === 400);
    });

    test('CIC-02: inativar imagem SEM uso inativa (estado, inativada_em) e é idempotente; reativar a devolve a ATIVA e limpa inativada_em', async () => {
      const r = await registrar({ nome: 'CIC02', imagem: descritor() });
      const i1 = await servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id });
      assert.deepEqual([i1.alterado, i1.imagem.estado], [true, 'INATIVA']);
      assert.notEqual((await a.q('SELECT inativada_em FROM imagens_empresa WHERE id = $1', [r.imagem.id])).rows[0].inativada_em, null);
      assert.equal((await servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id })).alterado, false);
      const r1 = await servico().reativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id });
      assert.deepEqual([r1.alterado, r1.imagem.estado], [true, 'ATIVA']);
      assert.equal((await a.q('SELECT inativada_em FROM imagens_empresa WHERE id = $1', [r.imagem.id])).rows[0].inativada_em, null);
    });

    test('CIC-03: inativar imagem EM USO por um material é 409 IMAGEM_EM_USO e NADA muda (estado, auditoria, vínculo); depois de soltar o material, inativa', async () => {
      const r = await registrar({ nome: 'CIC03', imagem: descritor() });
      const m = await a.material(A, 'Material CIC03');
      await a.q('UPDATE materiais SET imagem_empresa_id = $2 WHERE id = $1', [m, r.imagem.id]);
      const auditoriaAntes = (await a.auditoria('IMAGEM_MATERIAL_INATIVADA', A)).length;
      await esperarErro(servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id }), 409, 'IMAGEM_EM_USO');
      assert.equal((await a.q('SELECT estado FROM imagens_empresa WHERE id = $1', [r.imagem.id])).rows[0].estado, 'ATIVA');
      assert.equal((await a.imagemDoMaterial(m)).imagem_empresa_id, r.imagem.id);
      assert.equal((await a.auditoria('IMAGEM_MATERIAL_INATIVADA', A)).length, auditoriaAntes);
      await a.q('UPDATE materiais SET imagem_empresa_id = NULL WHERE id = $1', [m]);
      assert.equal((await servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id })).imagem.estado, 'INATIVA');
    });

    test('CIC-04: material INATIVO que ainda referencia a imagem também a mantém em uso (a regra é de referência, não de material ativo)', async () => {
      const r = await registrar({ nome: 'CIC04', imagem: descritor() });
      const m = await a.material(A, 'Material CIC04', { ativo: false });
      await a.q('UPDATE materiais SET imagem_empresa_id = $2 WHERE id = $1', [m, r.imagem.id]);
      await esperarErro(servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: r.imagem.id }), 409, 'IMAGEM_EM_USO');
    });

    test('CIC-05: imagem de OUTRA empresa e imagem inexistente dão exatamente o mesmo 404 IMAGEM_NAO_ENCONTRADA (sem revelar que o id existe), em renomear, inativar e reativar', async () => {
      const deB = await servico().registrarEmpresa(a.pool, { empresaId: B, atorId: ATOR_B, nome: 'CIC05', imagem: descritor() });
      for (const operacao of [
        (imagemId) => servico().renomear(a.pool, { empresaId: A, atorId: ATOR_A, imagemId, nome: 'x' }),
        (imagemId) => servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId }),
        (imagemId) => servico().reativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId }),
      ]) {
        const e1 = await operacao(deB.imagem.id).then(() => null, (e) => e);
        const e2 = await operacao(987654321).then(() => null, (e) => e);
        assert.deepEqual([e1.status, e1.codigo, e1.message], [404, 'IMAGEM_NAO_ENCONTRADA', e2.message]);
        assert.deepEqual([e2.status, e2.codigo], [404, 'IMAGEM_NAO_ENCONTRADA']);
      }
      assert.equal((await a.q('SELECT estado FROM imagens_empresa WHERE id = $1', [deB.imagem.id])).rows[0].estado, 'ATIVA', 'a imagem da outra empresa não foi tocada');
    });

    test('CIC-06: a biblioteca padrão não é gravável pelos serviços da empresa: não existe operação de escrita nela e o id numericamente igual ao de uma padrão não a alcança', async () => {
      const p = await a.padrao({ nome: 'Padrão intocável CIC06' });
      const exportadas = Object.keys(servico());
      assert.deepEqual(exportadas.filter((n) => /(registrar|renomear|inativar|reativar|criar|alterar|atualizar|remover|excluir).*padrao|padrao.*(registrar|renomear|inativar|reativar|criar|alterar|atualizar|remover|excluir)/i.test(n)), [], 'função de escrita sobre a padrão exposta');
      const propria = await registrar({ nome: 'CIC06', imagem: descritor() });
      await servico().renomear(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: propria.imagem.id, nome: 'CIC06 renomeada' });
      await servico().inativar(a.pool, { empresaId: A, atorId: ATOR_A, imagemId: propria.imagem.id });
      const depois = (await a.q('SELECT nome, ativo, versao FROM imagens_padrao WHERE id = $1', [p.id])).rows[0];
      assert.deepEqual(depois, { nome: 'Padrão intocável CIC06', ativo: true, versao: 1 });
    });

    // Ajuste V7 (exclusão de imagem privada, seção 2): o serviço nunca contém SQL, a padrão e o vínculo nunca apagam, e o ÚNICO apagamento
    // possível do sistema de imagens é o da própria linha da biblioteca da empresa (por empresa e id), na futura operação de exclusão.
    test('CIC-07: nenhum serviço, nenhuma biblioteca padrão e nenhum vínculo apaga; a biblioteca da empresa só pode apagar a própria linha, por empresa e id', async () => {
      const fs = require('node:fs');
      const path = require('node:path');
      const raiz = path.join(__dirname, '..', '..', 'src');
      const ler = (arquivo) => { try { return fs.readFileSync(path.join(raiz, arquivo), 'utf8'); } catch (e) { return assert.fail(`módulo ainda não implementado: ${arquivo}`); } };
      for (const arquivo of ['services/imagem-material.service.js', 'repositories/imagem-padrao.repository.js', 'repositories/material-imagem.repository.js']) {
        assert.equal(/\bDELETE\b|\bTRUNCATE\b/i.test(ler(arquivo)), false, `${arquivo} não pode apagar`);
      }
      const empresa = ler('repositories/imagem-empresa.repository.js');
      assert.equal(/\bTRUNCATE\b|\bDROP\b/i.test(empresa), false);
      for (const apagamento of empresa.match(/DELETE\s+FROM\s+[^`'"]*/gi) ?? []) assert.match(apagamento.replace(/\s+/g, ' '), /^DELETE FROM imagens_empresa WHERE empresa_id = \$1 AND id = \$2/i);
    });
  });
});
